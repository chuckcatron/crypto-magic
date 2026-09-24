import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { ApiController } from '../api/api.controller';
import { AlertService } from '../alerts/alert.service';
import { DeadmanService } from '../alerts/deadman.service';
import { PostMortemService } from '../insight/postmortem.service';
import { MarketDataService } from '../market-data/market-data.service';
import { TradingEngineService } from './engine.service';
import { ExecutorService } from './executor.service';
import { KillSwitchService } from './kill-switch.service';
import { PortfolioService } from './portfolio.service';
import { ReconciliationService } from './reconciliation.service';
import { RiskService } from './risk.service';

@Module({
  imports: [ScheduleModule.forRoot()],
  controllers: [ApiController],
  providers: [
    MarketDataService,
    KillSwitchService,
    PortfolioService,
    RiskService,
    ExecutorService,
    ReconciliationService,
    TradingEngineService,
    PostMortemService,
    AlertService,
    DeadmanService,
  ],
  exports: [TradingEngineService, PostMortemService, AlertService],
})
export class TradingModule {}
