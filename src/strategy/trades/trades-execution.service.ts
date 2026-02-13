import { Injectable, Logger } from '@nestjs/common';
import { TradesService } from './trades.service';
import { MarketService } from 'src/market/market.service';
import { OrdersService } from 'src/orders/orders.service';
import { FinalTradeToBePlacedEntity } from './entities/final-trade-to-be-placed.entity';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';

@Injectable()
export class TradesExecutionService {
  private readonly logger = new Logger(TradesExecutionService.name);
  private isExecuting = false;
  private tradeExecutionEnabled = false;

  // =====================================================
  // 🔹 TIME CONFIG (IST)
  // =====================================================
  // private readonly MARKET_START_TIME = '09:15';
  // private readonly MARKET_CUTOFF_TIME = '15:25';

  // Just declare — do NOT initialize yet
  private readonly MARKET_START_TIME: string;
  private readonly MARKET_CUTOFF_TIME: string;

  private readonly TIME_RESTRICTED_EXCHANGES = new Set([
    'NSE',
    'NFO',
    'BSE',
    'BFO',
  ]);

  constructor(
    private readonly tradesService: TradesService,
    private readonly marketService: MarketService,
    private readonly orderService: OrdersService,
    private readonly configService: ConfigService,
  ) {
    // ← now it's safe
    this.MARKET_START_TIME = this.configService.get<string>(
      'TRADING_START_TIME',
      '09:15',
    ); // ← add fallback if possible
    this.MARKET_CUTOFF_TIME = this.configService.get<string>(
      'TRADING_END_TIME',
      '15:30',
    );
    // 🔐 activate/deactivate scheduler execution
    this.tradeExecutionEnabled =
      this.configService.get<string>('ACTIVATE_TRADE_EXECUTION', 'false') ===
      'true';
  }

  // =====================================================
  // 🔹 IST TIME CHECK
  // =====================================================
  private isWithinTradingTime(): boolean {
    const now = new Date(
      new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }),
    );

    const [sh, sm] = this.MARKET_START_TIME.split(':').map(Number);
    const [eh, em] = this.MARKET_CUTOFF_TIME.split(':').map(Number);

    const start = new Date(now);
    start.setHours(sh, sm, 0, 0);

    const end = new Date(now);
    end.setHours(eh, em, 0, 0);

    return now >= start && now <= end;
  }

  // =====================================================
  // 🔹 HELPER TO INCREASE POSITIONS
  // =====================================================

  private async increasePosition(
    trade: FinalTradeToBePlacedEntity,
    tradingSymbol: string,
    quantity: number,
  ) {
    await this.orderService.placeOrder({
      buy_or_sell: trade.side === 'BUY' ? 'B' : 'S',
      product_type: this.resolveProductType(trade.productType),
      exchange: trade.exchange,
      tradingsymbol: tradingSymbol,
      quantity,
      price_type: 'MKT',
      price: 0,
      trigger_price: 0,
      discloseqty: 0,
      retention: 'DAY',
      amo: 'NO',
      remarks: `POSITION INCREASE | ${trade.strategyName}`,
    });

    this.logger.log(`➕ Increased position by ${quantity}`);
  }

  // =====================================================
  // 🔹 CANCEL ALL PENDING ORDERS FOR TOKEN (orderno only)
  // =====================================================
  private async cancelPendingOrdersForToken(
    token: string,
    exchange: string,
  ): Promise<void> {
    let orderBook: any[] = [];
    this.logger.log(
      `Checking pending orders to cancel for ${exchange}:${token}`,
    );

    try {
      const res = await this.orderService.getOrderBook();
      orderBook = Array.isArray(res?.trades) ? res.trades : [];
      // this.logger.log(
      //   `Fetched ${orderBook.length} orders from order book : `,
      //   orderBook,
      // );
    } catch (err) {
      this.logger.error('❌ Failed to fetch order book', err?.stack);
      return;
    }

    const cancellableStatuses = new Set(['OPEN', 'PENDING', 'TRIGGER_PENDING']);

    const pendingOrders = orderBook.filter(
      (o) =>
        o.token === token &&
        o.exch === exchange &&
        cancellableStatuses.has(o.status),
    );

    if (!pendingOrders.length) return;

    // this.logger.log(
    //   `Found ${pendingOrders.length} pending orders to cancel`,
    //   pendingOrders,
    // );

    this.logger.warn(
      `🧹 Cancelling ${pendingOrders.length} pending orders | ${exchange}:${token}`,
    );

    for (const order of pendingOrders) {
      try {
        await this.orderService.cancelOrder(order.norenordno);

        this.logger.log(`❌ Cancelled order ${order.norenordno}`);
      } catch (err) {
        this.logger.error(
          `❌ Failed to cancel order ${order.norenordno}`,
          err?.stack,
        );
      }
    }

    // let OMS settle
    await new Promise((r) => setTimeout(r, 500));
  }

  // =====================================================
  // 🔹 NET POSITION (AGGREGATED)
  // =====================================================
  private async getAggregatedNetPosition(
    token: string,
    exchange: string,
  ): Promise<number> {
    const netPositions = await this.orderService.getNetPositions();

    if (!Array.isArray(netPositions?.data)) return 0;

    return netPositions.data
      .filter((p) => p.token === token && p.exch === exchange)
      .reduce((sum, p) => sum + Number(p.netqty || 0), 0);
  }

  // =====================================================
  // 🔹 PRODUCT TYPE MAP
  // =====================================================
  private resolveProductType(productType: string): 'I' | 'C' | 'M' {
    if (productType === 'INTRADAY') return 'I';
    if (productType === 'DELIVERY') return 'C';
    return 'M';
  }

  // =====================================================
  // 🔹 Net position retry checker
  // =====================================================
  private async verifyNetPosition(
    token: string,
    exchange: string,
    expectedNetQty: number,
    retries = 3,
    delayMs = 1000,
  ): Promise<boolean> {
    for (let i = 1; i <= retries; i++) {
      await new Promise((r) => setTimeout(r, delayMs));

      const netQty = await this.getAggregatedNetPosition(token, exchange);

      this.logger.log(
        `🔄 Net check ${i}/${retries} → expected=${expectedNetQty}, actual=${netQty}`,
      );

      if (netQty === expectedNetQty) {
        return true;
      }
    }

    return false;
  }

  // =====================================================
  // 🔹 Close existing position (FULL CLOSE)
  // =====================================================
  private async closeFullPosition(
    netQty: number,
    trade: FinalTradeToBePlacedEntity,
    tradingSymbol: string,
  ) {
    if (netQty === 0) return;

    const closeSide = netQty > 0 ? 'SELL' : 'BUY';

    await this.orderService.placeOrder({
      buy_or_sell: closeSide === 'BUY' ? 'B' : 'S',
      product_type: this.resolveProductType(trade.productType),
      exchange: trade.exchange,
      tradingsymbol: tradingSymbol,
      quantity: Math.abs(netQty),
      price_type: 'MKT',
      price: 0,
      trigger_price: 0,
      discloseqty: 0,
      retention: 'DAY',
      amo: 'NO',
      remarks: 'AUTO CLOSE EXISTING POSITION',
    });

    this.logger.log(
      `🔁 Closed existing ${closeSide} | qty=${Math.abs(netQty)}`,
    );
  }

  // =====================================================
  // 🔹 EXECUTE ALL PENDING TRADES
  // =====================================================
  @Interval(1000)
  async executeTrades(): Promise<void> {
    // 🔒 HARD GATE
    if (!this.tradeExecutionEnabled) {
      this.logger.log('Trade execution is deactivated. Skipping cycle.');
      return;
    }
    if (this.isExecuting) {
      // this.logger.debug('⏳ Previous execution still running, skipping cycle');
      return;
    }

    this.isExecuting = true;

    try {
      //this.logger.log('🚀 Starting trade execution cycle');

      let pendingTrades: FinalTradeToBePlacedEntity[] = [];

      try {
        pendingTrades = await this.tradesService.getPendingTrades();
      } catch (err) {
        this.logger.error('Failed to fetch pending trades', err?.stack);
        return;
      }

      if (!pendingTrades.length) {
        //this.logger.debug('ℹ️ No pending trades found');
        return;
      }

      for (const trade of pendingTrades) {
        try {
          const exchange = trade.exchange;

          // Time restriction applies ONLY to listed exchanges
          if (
            this.TIME_RESTRICTED_EXCHANGES.has(exchange) &&
            !this.isWithinTradingTime()
          ) {
            this.logger.warn(
              `⏰ Trading time over. Skipping trade for ${exchange}|${trade.token}|${trade.symbol}`,
            );
            continue;
          }

          await this.executeSingleTrade(trade);
        } catch (err) {
          this.logger.error(
            `Trade execution failed | tradeId=${trade._id}`,
            err?.stack,
          );
        }
      }
    } finally {
      this.isExecuting = false; // 🔐 release lock
    }
  }

  /*

BUY 1 exists → BUY 1	Skip	FAILED
BUY 1 exists → BUY 2	Buy 1	PLACED
BUY 2 exists → BUY 1	Skip	FAILED
BUY exists → SELL	Close → Sell	PLACED
Any qty → qty 0	Close all	PLACED

*/

  // =====================================================
  // 🔹 EXECUTE SINGLE TRADE
  // =====================================================
  private async executeSingleTrade(
    trade: FinalTradeToBePlacedEntity,
  ): Promise<void> {
    this.logger.log(
      `📌 Executing trade | ${trade.exchange}:${trade.token} | side=${trade.side} | lots=${trade.quantityLots}`,
    );

    // 🧹 STEP 0: Cancel pending orders for same token (to save from short margin in NFO)
    await this.cancelPendingOrdersForToken(trade.token, trade.exchange);

    // 1️⃣ SECURITY INFO (MANDATORY)
    const security = await this.marketService.getSecurityInfo({
      exchange: trade.exchange,
      token: trade.token,
    });

    if (!security?.tsym || !security?.ls) {
      await this.tradesService.markTradeFailed(
        trade._id,
        'INVALID_SECURITY_INFO',
      );
      return;
    }

    const tradingSymbol = security.tsym;
    const lotSize = Number(security.ls) || 1;

    const desiredNetQty =
      trade.quantityLots * lotSize * (trade.side === 'BUY' ? 1 : -1);

    // 2️⃣ CURRENT NET POSITION
    const netQty = await this.getAggregatedNetPosition(
      trade.token,
      trade.exchange,
    );

    this.logger.log(`📊 NetQty=${netQty} | Desired=${desiredNetQty}`);

    // =====================================================
    // 🔴 CASE: SQUARE-OFF ONLY (quantityLots === 0)
    // =====================================================
    if (trade.quantityLots === 0) {
      if (netQty !== 0) {
        await this.closeFullPosition(netQty, trade, tradingSymbol);

        const ok = await this.verifyNetPosition(trade.token, trade.exchange, 0);

        if (ok) {
          await this.tradesService.markTradePlaced(trade._id);
        }
      } else {
        await this.tradesService.markTradePlaced(trade._id);
      }
      return;
    }

    // =====================================================
    // 🟡 SAME SIDE POSITION EXISTS
    // =====================================================
    if (netQty !== 0 && Math.sign(netQty) === Math.sign(desiredNetQty)) {
      const absNet = Math.abs(netQty);
      const absDesired = Math.abs(desiredNetQty);

      // ❌ SAME QTY → DO NOTHING
      if (absNet === absDesired) {
        this.logger.warn(
          `⚠️ Trade already exists | netQty=${netQty}. Skipping.`,
        );

        await this.tradesService.markTradeFailed(
          trade._id,
          'TRADE_ALREADY_EXISTS_SAME_QTY',
        );
        return;
      }

      // ❌ DESIRED < EXISTING → NO REDUCTION
      if (absDesired < absNet) {
        this.logger.warn(
          `⚠️ Existing qty (${absNet}) > desired (${absDesired}). Reduction not allowed.`,
        );

        await this.tradesService.markTradeFailed(
          trade._id,
          'DESIRED_QTY_LESS_THAN_EXISTING',
        );
        return;
      }

      // ✅ DESIRED > EXISTING → INCREASE ONLY
      const remainingQty = absDesired - absNet;

      await this.increasePosition(trade, tradingSymbol, remainingQty);

      const verified = await this.verifyNetPosition(
        trade.token,
        trade.exchange,
        desiredNetQty,
      );

      if (verified) {
        await this.tradesService.markTradePlaced(trade._id);
      }

      return;
    }

    // =====================================================
    // 🔁 OPPOSITE POSITION EXISTS
    // =====================================================
    if (netQty !== 0 && Math.sign(netQty) !== Math.sign(desiredNetQty)) {
      this.logger.log(
        `🔁 Opposite position detected.. desired qty: ${desiredNetQty}, existing qty: ${netQty}`,
      );

      await this.closeFullPosition(netQty, trade, tradingSymbol);
    }

    // =====================================================
    // 🚀 FRESH ENTRY
    // =====================================================
    await this.orderService.placeOrder({
      buy_or_sell: trade.side === 'BUY' ? 'B' : 'S',
      product_type: this.resolveProductType(trade.productType),
      exchange: trade.exchange,
      tradingsymbol: tradingSymbol,
      quantity: Math.abs(desiredNetQty),
      price_type: 'MKT',
      price: 0,
      trigger_price: 0,
      discloseqty: 0,
      retention: 'DAY',
      amo: 'NO',
      remarks: `AUTO EXEC | ${trade.strategyName}`,
    });

    const verified = await this.verifyNetPosition(
      trade.token,
      trade.exchange,
      desiredNetQty,
    );

    if (verified) {
      await this.tradesService.markTradePlaced(trade._id);
    } else {
      this.logger.warn(`⚠️ Net position mismatch → expected=${desiredNetQty}`);
    }
  }

  // =====================================================
  // 🔹 CLOSE POSITION BY SYMBOL OR TOKEN
  // =====================================================
  async closePositionBySymbolOrToken(
    tradingSymbolName: string,
    tokenNumber: string,
  ): Promise<void> {
    tradingSymbolName = tradingSymbolName.toUpperCase();
    this.logger.log(
      `📌 Closing positions for symbol=${tradingSymbolName} or token=${tokenNumber}`,
    );

    const netPositions = await this.orderService.getNetPositions();

    if (!Array.isArray(netPositions?.data)) {
      this.logger.warn('No net positions data available');
      return;
    }

    const matchingPositions = netPositions.data.filter(
      (p) => p.token === tokenNumber || p.tsym === tradingSymbolName,
    );

    if (!matchingPositions.length) {
      this.logger.warn('No matching positions found for SquareOff');
      return;
    }

    for (const pos of matchingPositions) {
      const netQty = Number(pos.netqty || 0);

      if (netQty === 0) continue;

      const closeSide = netQty > 0 ? 'SELL' : 'BUY';

      // Assume INTRADAY for manual closes, can be made configurable
      const productType = 'INTRADAY';

      await this.orderService.placeOrder({
        buy_or_sell: closeSide === 'BUY' ? 'B' : 'S',
        product_type: this.resolveProductType(productType),
        exchange: pos.exch,
        tradingsymbol: pos.tsym,
        quantity: Math.abs(netQty),
        price_type: 'MKT',
        price: 0,
        trigger_price: 0,
        discloseqty: 0,
        retention: 'DAY',
        amo: 'NO',
        remarks: `MANUAL Square off CLOSE | ${pos.tsym}`,
      });

      this.logger.log(
        `🔁 Closed position | ${pos.exch}:${pos.tsym} | qty=${Math.abs(netQty)}`,
      );
    }
  }
}
