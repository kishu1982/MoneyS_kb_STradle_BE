import { OrdersService } from 'src/orders/orders.service';
import { ConfigService } from '@nestjs/config';
import {
  appendTargetTrack,
  readTargetTrack,
  isTradeAlreadyClosed,
  countActionReason,
  canAppendAction,
  getTargetTrackKey,
} from './target.helpers';
import { processTimeBasedExit } from './timeBasedExit.helper';
import { IsNumber, IsString } from 'class-validator';

export class TargetManager {
  private readonly TARGET_PERCENT: number;

  constructor(
    private readonly ordersService: OrdersService,
    private readonly config: ConfigService,
  ) {
    const raw = this.config.get<string>('TARGET_FIRST_PERCENT', '0.25');
    const value = Number(raw);
    this.TARGET_PERCENT = value > 1 ? value / 100 : value;
  }

  async checkAndProcessTarget({
    tick,
    netPosition,
    tradeBook,
    instrument,
  }: {
    tick: { tk: string; e: string; lp: number };
    netPosition: any;
    tradeBook: any[];
    instrument: any;
  }) {
    const token = tick.tk;
    const ltp = tick.lp;



    // 🔒 no position → do nothing
    const netQty = Math.abs(Number(netPosition.netqty));
    if (netQty <= 0) return;

    // 🔑 find latest trade (entry trade)
    const positionSide = Number(netPosition.netqty) > 0 ? 'BUY' : 'SELL';

    const entryTradeSide = positionSide === 'BUY' ? 'B' : 'S';

    // 🔒 only trades matching open position side
    const entryTrades = tradeBook
      .filter(
        (t) =>
          t.token === token &&
          t.exch === tick.e &&
          t.trantype === entryTradeSide,
      )
      .sort(
        (a, b) => new Date(b.exch_tm).getTime() - new Date(a.exch_tm).getTime(),
      );

    if (!entryTrades.length) return;

    const entryTrade = entryTrades[0];

    const entryOrderId = entryTrade.norenordno;
    const entryPrice = Number(entryTrade.flprc);

    if (!entryOrderId) return;

    // 🔑 per-trade tracking key
    const trackKey = getTargetTrackKey(token, entryOrderId);
    const track = readTargetTrack(trackKey);

    // need to keep this above trade already closed fucntion check
    // ===============================
    // 🚀 Close open positions ORDER if no new high low hit in given N number of last minutes
    // simply calling private fucntion of this class
    // ===============================
    await this.handleTimeBasedExit({
      tick,
      netPosition,
      instrument,
      entryOrderId,
    });

    // ===============================
    // 🚫 TRADE ALREADY CLOSED
    // ===============================
    if (isTradeAlreadyClosed(track)) {
      const skippedCount = countActionReason(
        track,
        'SKIPPED',
        'TRADE_ALREADY_CLOSED',
      );

      if (skippedCount < 2) {
        appendTargetTrack(trackKey, {
          action: 'SKIPPED',
          reason: 'TRADE_ALREADY_CLOSED',
        });
      }
      return;
    }

    //const entryPrice = Number(lastTrade.prc);
    const side = Number(netPosition.netqty) > 0 ? 'BUY' : 'SELL';

    const targetPrice =
      side === 'BUY'
        ? entryPrice * (1 + this.TARGET_PERCENT)
        : entryPrice * (1 - this.TARGET_PERCENT);

    const targetHit = side === 'BUY' ? ltp >= targetPrice : ltp <= targetPrice;
    console.log(
      `Target waiting to be hit for token: ${token} at price: ${targetPrice.toFixed(2)} | LTP: ${ltp},`,
    );

    // safety check of target price
    if (targetPrice <= 0) {
      console.log(
        `Invalid target price calculated: ${targetPrice} for token: ${token}`,
      );
      return;
    }
    if (!targetHit) return;

    // ===============================
    // 🛑 NOT MORE THAN 1 LOT
    // ===============================
    const lotSize = Number(instrument.lotSize || instrument.lotsize || 1);

    if (netQty <= lotSize) {
      if (
        canAppendAction(
          track,
          'TARGET_HIT_NOT_CLOSED',
          'NET_QTY_NOT_MORE_THAN_1_LOT',
        )
      ) {
        appendTargetTrack(trackKey, {
          action: 'TARGET_HIT_NOT_CLOSED',
          reason: 'NET_QTY_NOT_MORE_THAN_1_LOT',
          entryPrice,
          targetPrice,
          netQty,
        });
      }
      return;
    }

    // ===============================
    // ✅ CLOSE EXACT 50% (LOT SAFE)
    // ===============================
    const maxCloseQty = Math.floor(netQty / 2);
    const closeQty = Math.floor(maxCloseQty / lotSize) * lotSize;

    if (closeQty < lotSize) {
      if (
        canAppendAction(
          track,
          'TARGET_HIT_NOT_CLOSED',
          'CLOSE_QTY_LESS_THAN_ONE_LOT_AFTER_ROUNDING',
        )
      ) {
        appendTargetTrack(trackKey, {
          action: 'TARGET_HIT_NOT_CLOSED',
          reason: 'CLOSE_QTY_LESS_THAN_ONE_LOT_AFTER_ROUNDING',
          entryPrice,
          targetPrice,
          netQty,
          calculatedCloseQty: closeQty,
        });
      }
      return;
    }

    // ===============================
    // 🚀 PLACE TARGET ORDER
    // ===============================
    await this.ordersService.placeOrder({
      buy_or_sell: side === 'BUY' ? 'S' : 'B',
      product_type: netPosition.prd,
      exchange: tick.e,
      tradingsymbol: instrument.tradingSymbol,
      quantity: closeQty,
      price_type: 'MKT',
      retention: 'DAY',
      remarks: 'AUTO_TARGET_50_PERCENT',
    });

    appendTargetTrack(trackKey, {
      action: 'TARGET_BOOKED_50_PERCENT',
      entryPrice,
      targetPrice,
      netQty,
      closeQty,
    });
  }

  // need to keep this above trade already closed fucntion check
  //  =============================== //
  // 🚀 Close open positions ORDER if no new high low hit in given N number of last minutes
  //  ===============================
  private async handleTimeBasedExit({
    tick,
    netPosition,
    instrument,
    entryOrderId, 
  }: {
    tick: { tk: string; e: string; lp: number };
    netPosition: any;
    instrument: any;
    entryOrderId: string;
  }) {
    await processTimeBasedExit({
      tick,
      netPosition,
      instrument,
      entryOrderId,
      exitAfterMinutes: Number(this.config.get('TIME_EXIT_MINUTES', 15)),
      closePositionFn: async (side, qty) => {
        await this.ordersService.placeOrder({
          buy_or_sell: side === 'BUY' ? 'S' : 'B',
          product_type: netPosition.prd,
          exchange: tick.e,
          tradingsymbol: instrument.tradingSymbol,
          quantity: qty,
          price_type: 'MKT',
          retention: 'DAY',
          remarks: 'AUTO_TIME_EXIT',
        });
      },
    });
  }
}
