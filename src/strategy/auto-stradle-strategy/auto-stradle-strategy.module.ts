import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { AutoStradleDataEntity } from 'src/database/entities/auto-stradle-data.entity';
import { AutoStradleStrategyController } from './auto-stradle-strategy.controller';
import { AutoStradleStrategyService } from './auto-stradle-strategy.service';
import { AutoStradleHelperExecution } from './autostradle_helper_execution';
import { OrdersModule } from 'src/orders/orders.module';
import { MarketModule } from 'src/market/market.module';
import { TradingviewTradeConfigModule } from '../tradingview-trade-config/tradingview-trade-config.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([AutoStradleDataEntity]),
    ScheduleModule.forRoot(),
    OrdersModule,
    MarketModule,
    TradingviewTradeConfigModule,
  ],
  controllers: [AutoStradleStrategyController],
  providers: [AutoStradleStrategyService, AutoStradleHelperExecution],
  exports: [AutoStradleStrategyService, AutoStradleHelperExecution],
})
export class AutoStradleStrategyModule {}
