import { Controller, Get, Query } from '@nestjs/common';
import { PaperTraderService } from '../paper/paper-trader.service';
import { PaperStore } from '../paper/store';

function limitOf(raw: string | undefined, fallback: number): number {
  const n = Number(raw ?? fallback);
  return Number.isInteger(n) && n > 0 ? Math.min(n, 500) : fallback;
}

/** Read-only views of the paper accounts. Everything here is paper money. */
@Controller('api')
export class StatusController {
  constructor(
    private readonly trader: PaperTraderService,
    private readonly store: PaperStore,
  ) {}

  @Get('status')
  status() {
    return this.trader.status();
  }

  @Get('trades')
  trades(@Query('limit') limit?: string) {
    return this.store.recentTrades(limitOf(limit, 50));
  }

  @Get('events')
  events(@Query('limit') limit?: string) {
    return this.store.recentEvents(limitOf(limit, 50));
  }
}
