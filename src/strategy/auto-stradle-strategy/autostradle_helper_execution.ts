import {
  Injectable,
  Logger,
  OnModuleInit,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AutoStradleStrategyService } from './auto-stradle-strategy.service';
import { ConfigService } from '@nestjs/config';
import { MarketService } from 'src/market/market.service';
import { OrdersService } from 'src/orders/orders.service';
import * as path from 'path';
import * as fs from 'fs';
import { TradingviewTradeConfigService } from '../tradingview-trade-config/tradingview-trade-config.service';

export interface WebSocketTickData {
  e?: string; // exchange name
  tk?: string; // script token
  ts?: string; // symbol name
  lp?: string; // LTP
  ti?: string; // tick size
  bp1?: string; // best bid price
  ap1?: string; // best ask price
  [key: string]: any; // other fields can be present but are not used in current logic
}

@Injectable()
export class AutoStradleHelperExecution implements OnModuleInit {
  private readonly logger = new Logger(AutoStradleHelperExecution.name);

  private subscriptionList: string[] = [];
  private filteredWebSocketData = new Map<string, WebSocketTickData>();

  private isAutoStradleEnabled = false;

  private activeStradleData: any[] = [];

  private tradingViewConfigData: any[] = []; // for getting and storing trading view trade configuration data which can be used in execution logic

  private instruments: any[] = [];
  //   private instrumentMap = new Map<string, any>();

  // ⭐ PREBUILT PAYLOAD CACHE
  private preparedPayloadMap = new Map<string, any[]>();

  // store latest net positions
  private netPositions: any[] = [];

  // Sleep ms between processing each payload to avoid hitting rate limits ( adjust as needed )
  private payloadProcessingDelay = 500;

  // promis resolve wait logic variable Add queue variable
  private syncQueue: Promise<void> = Promise.resolve();
  private quoteQueue: Promise<any> = Promise.resolve(); // for quotes update
  private netPositionQueue: Promise<void> = Promise.resolve(); // for net position update

  constructor(
    @Inject(forwardRef(() => AutoStradleStrategyService))
    private readonly autoStradleService: AutoStradleStrategyService,
    private readonly ConfigService: ConfigService,
    private readonly marketService: MarketService,
    private readonly ordersService: OrdersService,
    private readonly tradingViewConfigService: TradingviewTradeConfigService,
  ) {}

  async onModuleInit() {
    this.logger.log('[INIT] Initializing AutoStradleHelperExecution...');

    const env = this.ConfigService.get<string>(
      'IS_AUTO_STRADLE_ENABLED',
      'false',
    );
    this.isAutoStradleEnabled = env.toLowerCase() === 'true';

    this.logger.log(
      this.isAutoStradleEnabled
        ? '[INIT] AutoStradleHelperExecution is enabled'
        : '[INIT] AutoStradleHelperExecution is disabled',
    );

    if (!this.isAutoStradleEnabled) return;

    // load instruments
    const filePath = path.join(
      process.cwd(),
      'data',
      'instrumentinfo',
      'instruments.json',
    );
    this.instruments = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    // get data of trading view trade configuration to be used in execution logic when needed
    this.tradingViewConfigData =
      await this.tradingViewConfigService.getActiveConfigs();

    // build index
    // for (const i of this.instruments) {
    //   const key = `${i.exch}|${i.instrument}|${i.optionType}|${i.expiry}|${i.symbol}|${i.strike}`;
    //   this.instrumentMap.set(key, i);
    // }

    await this.refreshPreparedPayloads();
  }

  //(async sleep helper)
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  //---------------------------------------------------
  // MASTER CRON (every 10 sec)
  //---------------------------------------------------

  @Cron(CronExpression.EVERY_10_SECONDS)
  async refreshPreparedPayloads() {
    try {
      if (!this.isAutoStradleEnabled) return;

      // // ⭐ refresh net positions first
      // await this.refreshNetPositions();

      // 1️⃣ load active stradles
      this.activeStradleData = await this.autoStradleService.findActive();

      this.preparedPayloadMap.clear();

      // 2️⃣ build payloads
      for (const stradle of this.activeStradleData) {
        const subscriptionKey = `${stradle.exchange}|${stradle.tokenNumber}`;

        const tick = this.filteredWebSocketData.get(subscriptionKey);

        if (!tick?.lp) continue;

        const lp = Number(tick.lp);

        const payloadLegs: any[] = [];

        for (const leg of stradle.legsData || []) {
          const strike = this.calcStrike(
            lp,
            stradle.otmDifference,
            leg.optionType,
            stradle.symbolName,
          );
          // this.logger.log(
          //   `Calculated strike for leg ${leg.side} for ${tick.tk} as CMP is ${tick.lp} and strike is ${strike}`,
          // );

          //   const instKey = `${leg.exch}|${leg.instrument}|${leg.optionType}|${leg.expiry}|${stradle.symbolName}|${strike}`;

          // filtering name nifty index to nifty
          const indexNameFilter = {
            'Nifty 50': 'NIFTY',
            'Nifty Bank': 'BANKNIFTY',
            'NIFTY BANK': 'BANKNIFTY',
          };

          if (indexNameFilter[stradle.symbolName]) {
            stradle.symbolName = indexNameFilter[stradle.symbolName];
          }

          /////////////////////////////////////////

          // this.logger.log('stradle symbol name recvied: ', stradle.symbolName);

          //   const instrument = this.instrumentMap.get(instKey);
          const instrumentResults = this.instruments.filter(
            (i) =>
              i.exchange === leg.exch &&
              i.instrument === leg.instrument &&
              i.optionType === leg.optionType &&
              i.expiry === leg.expiry &&
              i.symbol === stradle.symbolName &&
              Number(i.strikePrice) === strike,
          );

          if (!instrumentResults.length) continue;

          const instrument = instrumentResults[0];

          //   this.logger.log(
          //     `Looking for instrument  - Found: ${!!instrument} : data is : `,
          //     instrument,
          //   );

          if (!instrument) continue;

          // quote fetch ONLY here
          // const quote = await this.marketService.getQuotes({
          //   exch: instrument.exchange,
          //   token: instrument.token,
          // });
          const quote = await this.enqueueQuoteRequest(instrument);

          if (!quote?.lp) continue;

          const legLP = Number(quote.lp);
          const lotsize = Number(instrument.lotSize);

          const quantityLots = Math.round(
            stradle.amountForLotCalEachLeg / (legLP * lotsize),
          );

          // this.logger.log(
          //   `Calculated quantity for leg ${leg.side} for ${tick.tk} as CMP is ${tick.lp} and legLP is ${legLP} and lotsize is ${lotsize} and quantityLots is ${quantityLots}`,
          // );

          payloadLegs.push({
            tokenNumber: instrument.token,
            exchange: instrument.exchange,
            symbolName: instrument.tradingSymbol,
            quantityLots,
            side: leg.side,
          });

          // this.logger.debug(
          //   `final payload leg for ${instrument.tradingSymbol} is : `,
          //   payloadLegs,
          // );

          // ⭐ delay to avoid API rate limit
          await this.sleep(this.payloadProcessingDelay);
        }

        const payload = {
          strategyName: stradle.strategyName,
          tokenNumber: stradle.tokenNumber,
          exchange: stradle.exchange,
          symbolName: stradle.symbolName,
          quantityLots: stradle.quantityLots,
          side: stradle.side,
          productType: stradle.productType,
          legs: stradle.legs,
          signalStatus: stradle.status,
          toBeTradedOn: payloadLegs,
        };

        // this.logger.debug('final payload prepared for Debug: ', payload);

        // calling sync fucntion too
        await this.enqueueSync(payload);

        let payloadArray = this.preparedPayloadMap.get(subscriptionKey);

        if (!payloadArray) {
          payloadArray = [];
          this.preparedPayloadMap.set(subscriptionKey, payloadArray);
        }

        payloadArray.push(payload);
      }

      this.logger.log(`[CRON] Prepared payloads updated`);
    } catch (error) {
      this.logger.error(`[CRON_REFRESH] ${error.message}`, error.stack);
    }
  }

  //---------------------------------------------------

  async processWebSocketData(data: WebSocketTickData) {
    try {
      if (!this.isAutoStradleEnabled) {
        this.logger.log(
          '[Env Check] AutoStradleHelperExecution is disabled ( so skipping processing WebSocket data )',
        );
        return;
      }

      // ⭐ refresh net positions first
      await this.enqueueRefreshNetPositions();

      const exchange = data.e;
      const token = data.tk;

      if (!exchange || !token) return;

      const subscriptionKey = `${exchange}|${token}`;

      // get previous stored tick
      const previousTick =
        this.filteredWebSocketData.get(subscriptionKey) || {};

      // merge old + new tick data
      const mergedTick: WebSocketTickData = {
        ...previousTick,
        ...data,
      };

      // store merged tick
      this.filteredWebSocketData.set(subscriptionKey, mergedTick);
      // store each token data updates it with latest tick data
      // this.logger.debug(`[WS] Updated ${subscriptionKey}`, mergedTick);

      // ⭐ ONLY execution using prepared payload
      const payloads = this.preparedPayloadMap.get(subscriptionKey);

      if (!payloads?.length) return;

      for (const payload of payloads) {
        //   this.logger.debug('[AUTO STRADLE PAYLOAD]', payload);
        //this.logger.debug(`net positions for reference: `, this.netPositions);
        // here call ordersService when needed
        // await this.ordersService.execute(payload);
      }
    } catch (error) {
      this.logger.error(
        `[PROCESS_WS_DATA] Error processing WebSocket data: ${error.message}`,
        error.stack,
      );
    }
  }

  private calcStrike(
    lp: number,
    otm: number,
    type: string,
    symbolName: string,
  ) {
    const diff = (otm * lp) / 100;

    const raw = type === 'CE' ? lp + diff : lp - diff;
    // NEED TO KEEP ROUND AS 100 COZ BSE AND BANK NIFTY DOESNT SUPPORT 50 ROUND

    if (symbolName.includes('NIFTY')) {
      return Math.round(raw / 50) * 50;
    } else {
      return Math.round(raw / 100) * 100;
    }
  }

  /*
  //8888888888888888888888888888
  generate payload
      ↓
compare with tradingview config
      ↓
if mismatch → update
else skip
  */

  // main sync fucntion that compairs prepared payload with existing trading view trade configuration and update or create new config when needed to keep trading view configuration in sync with auto stradle strategy data
  private async syncTradingViewConfigIfNeeded(payload: any) {
    try {
      // find matching existing config
      const existingConfig = this.tradingViewConfigData.find(
        (cfg) =>
          cfg.tokenNumber === payload.tokenNumber &&
          //cfg.exchange === payload.exchange &&
          cfg.symbolName === payload.symbolName &&
          cfg.side === payload.side,
      );

      //   this.logger.debug(
      //     `payload recived for sync : ${payload.symbolName}|${payload.tokenNumber}|${payload.side}`,
      //   );
      //   this.logger.debug(
      //     `existing config found for sync : ${!!existingConfig} and data is : `,
      //     existingConfig,
      //   );

      // ---------- CASE 1: NO EXISTING CONFIG ----------
      if (!existingConfig) {
        await this.tradingViewConfigService.saveOrUpdate(payload);

        this.logger.warn(
          `[TV SYNC] Created new config (no existing match) for ${payload.symbolName}|${payload.exchange}|${payload.tokenNumber}|${payload.side}`,
        );

        return;
      }

      // ---------- CASE 2: CHECK IF DATA DIFFERENT ----------

      //   const isDifferent = !this.isPayloadSame(existingConfig, payload);
      const diffResult = this.getPayloadDiff(existingConfig, payload);

      if (!diffResult.isSame) {
        await this.tradingViewConfigService.saveOrUpdate(payload);

        this.logger.warn(
          `[TV SYNC] Updated config for ${payload.exchange}|${payload.tokenNumber}|${payload.side} | Reason: ${diffResult.reasons.join(', ')}`,
        );
      } else {
        this.logger.debug(
          `[TV SYNC] Already synced for ${payload.exchange}|${payload.tokenNumber}|${payload.side}`,
        );
      }
    } catch (error) {
      this.logger.error(`[TV SYNC ERROR] ${error.message}`, error.stack);
    }
  }

  //   ADD DEEP COMPARISON FUNCTION  for both the payloads

  //   private isPayloadSame(existing: any, generated: any): boolean {
  //     // compare main fields
  //     const mainSame =
  //       existing.strategyName === generated.strategyName &&
  //       existing.tokenNumber === generated.tokenNumber &&
  //       existing.exchange === generated.exchange &&
  //       existing.symbolName === generated.symbolName &&
  //       existing.quantityLots === generated.quantityLots &&
  //       existing.side === generated.side &&
  //       existing.productType === generated.productType &&
  //       existing.legs === generated.legs &&
  //       existing.signalStatus === generated.signalStatus;

  //     if (!mainSame) return false;

  //     // compare legs
  //     const existingLegs = existing.toBeTradedOn || [];
  //     const generatedLegs = generated.toBeTradedOn || [];

  //     if (existingLegs.length !== generatedLegs.length) return false;

  //     // deep compare legs (sorted)
  //     const sortFn = (a, b) => a.tokenNumber.localeCompare(b.tokenNumber);

  //     const sortedExisting = [...existingLegs].sort(sortFn);
  //     const sortedGenerated = [...generatedLegs].sort(sortFn);

  //     for (let i = 0; i < sortedExisting.length; i++) {
  //       const e = sortedExisting[i];
  //       const g = sortedGenerated[i];

  //       if (
  //         e.tokenNumber !== g.tokenNumber ||
  //         e.exchange !== g.exchange ||
  //         e.symbolName !== g.symbolName ||
  //         e.quantityLots !== g.quantityLots ||
  //         e.side !== g.side
  //       ) {
  //         return false;
  //       }
  //     }

  //     return true;
  //   }

  private getPayloadDiff(
    existing: any,
    generated: any,
  ): { isSame: boolean; reasons: string[] } {
    const reasons: string[] = [];

    // ---------- compare main fields ----------

    if (existing.strategyName !== generated.strategyName)
      reasons.push('strategyName changed');

    if (existing.tokenNumber !== generated.tokenNumber)
      reasons.push('tokenNumber changed');

    if (existing.exchange !== generated.exchange)
      reasons.push('exchange changed');

    if (existing.symbolName !== generated.symbolName)
      reasons.push('symbolName changed');

    if (existing.quantityLots !== generated.quantityLots)
      reasons.push('quantityLots changed');

    if (existing.side !== generated.side) reasons.push('side changed');

    if (existing.productType !== generated.productType)
      reasons.push('productType changed');

    if (existing.legs !== generated.legs) reasons.push('legs count changed');

    if (existing.signalStatus !== generated.signalStatus)
      reasons.push('signalStatus changed');

    // ---------- compare legs ----------

    const existingLegs = existing.toBeTradedOn || [];
    const generatedLegs = generated.toBeTradedOn || [];

    if (existingLegs.length !== generatedLegs.length) {
      reasons.push('legs length mismatch');
    } else {
      const sortFn = (a, b) => a.tokenNumber.localeCompare(b.tokenNumber);

      const sortedExisting = [...existingLegs].sort(sortFn);
      const sortedGenerated = [...generatedLegs].sort(sortFn);

      for (let i = 0; i < sortedExisting.length; i++) {
        const e = sortedExisting[i];
        const g = sortedGenerated[i];

        if (e.tokenNumber !== g.tokenNumber)
          reasons.push(`leg token mismatch at index ${i}`);

        if (e.exchange !== g.exchange)
          reasons.push(`leg exchange mismatch at index ${i}`);

        if (e.symbolName !== g.symbolName)
          reasons.push(`leg symbol mismatch at index ${i}`);

        if (e.quantityLots !== g.quantityLots)
          reasons.push(`leg quantity mismatch at index ${i}`);

        if (e.side !== g.side) reasons.push(`leg side mismatch at index ${i}`);
      }
    }

    return {
      isSame: reasons.length === 0,
      reasons,
    };
  }

  //Create queued wrapper function
  private enqueueSync(payload: any): Promise<void> {
    this.syncQueue = this.syncQueue.then(async () => {
      try {
        await this.syncTradingViewConfigIfNeeded(payload);
      } catch (err) {
        this.logger.error(`[TV SYNC QUEUE ERROR] ${err.message}`, err.stack);
      }
    });

    return this.syncQueue;
  }

  // getting net position
  // private async refreshNetPositions(): Promise<void> {
  //   try {
  //     const result = await this.ordersService.getNetPositions();

  //     if (result.success) {
  //       this.netPositions = result.data || [];
  //       this.logger.debug(
  //         `[NET POSITIONS] Updated (${this.netPositions.length})`,
  //       );
  //     } else {
  //       this.logger.warn(`[NET POSITIONS] API returned failure`);
  //     }
  //   } catch (error) {
  //     this.logger.error(`[NET POSITIONS ERROR] ${error.message}`, error.stack);
  //   }
  // }

  // wraper for getting net position with queue to avoid multiple concurrent calls and ensure latest data is used in execution logic
  private enqueueRefreshNetPositions(): Promise<void> {
    this.netPositionQueue = this.netPositionQueue.then(async () => {
      try {
        const result = await this.ordersService.getNetPositions();

        if (result.success) {
          this.netPositions = result.data || [];

          this.logger.debug(
            `[NET POSITIONS] Updated (${this.netPositions.length})`,
          );
        } else {
          this.logger.warn(`[NET POSITIONS] API returned failure`);
        }
      } catch (error) {
        this.logger.error(
          `[NET POSITIONS ERROR] ${error.message}`,
          error.stack,
        );
      }
    });

    return this.netPositionQueue;
  }

  // waiting till quotes are updated with previous await promise
  private enqueueQuoteRequest(instrument: any) {
    this.quoteQueue = this.quoteQueue.then(async () => {
      return await this.marketService.getQuotes({
        exch: instrument.exchange,
        token: instrument.token,
      });
    });

    return this.quoteQueue;
  }
}
