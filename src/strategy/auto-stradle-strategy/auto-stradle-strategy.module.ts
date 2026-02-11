import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AutoStradleDataEntity } from 'src/database/entities/auto-stradle-data.entity';
import { AutoStradleStrategyController } from './auto-stradle-strategy.controller';
import { AutoStradleStrategyService } from './auto-stradle-strategy.service';

@Module({
  imports: [TypeOrmModule.forFeature([AutoStradleDataEntity])],
  controllers: [AutoStradleStrategyController],
  providers: [AutoStradleStrategyService],
  exports: [AutoStradleStrategyService],
})
export class AutoStradleStrategyModule {}
