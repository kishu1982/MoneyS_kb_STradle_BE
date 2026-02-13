import { Controller, Get, Logger, Post, Body } from '@nestjs/common';
import { TradesService } from './trades.service';
import { TradesExecutionService } from './trades-execution.service';

@Controller('savedtrades')
export class TradesController {
  private readonly logger = new Logger(TradesController.name);

  constructor(
    private readonly tradesService: TradesService,
    private readonly executionService: TradesExecutionService,
  ) {}

  /**
   * GET /trades
   * Fetch all saved trades
   */
  @Get()
  async getAllTrades() {
    this.logger.log('Request received to fetch all trades');
    return this.tradesService.getAllTrades();
  }

  // for running trade execution manually
  @Post('/run')
  async runExecution(): Promise<void> {
    this.logger.log('Manual trade execution triggered');
    await this.executionService.executeTrades();
  }

  /**
   * POST /savedtrades/close-position
   * Close positions by trading symbol name or token number
   */
  @Post('close-position')
  async closePosition(
    @Body() body: { tradingSymbolName: string; tokenNumber: string },
  ): Promise<{ message: string }> {
    const { tradingSymbolName, tokenNumber } = body;
    this.logger.log(
      `Request to close positions for symbol=${tradingSymbolName} or token=${tokenNumber}`,
    );

    await this.executionService.closePositionBySymbolOrToken(
      tradingSymbolName,
      tokenNumber,
    );

    return { message: 'Position close orders placed successfully' };
  }
}
