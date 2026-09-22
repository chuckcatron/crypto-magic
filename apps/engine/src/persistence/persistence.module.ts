import { Global, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../config/tokens';
import type { AppConfig } from '../config/config.schema';
import { openDatabase, type Db } from './database';
import { DATABASE } from './tokens';
import { EventRepository } from './repositories/event.repository';
import { OrderRepository } from './repositories/order.repository';
import { PositionRepository } from './repositories/position.repository';
import { StateRepository } from './repositories/state.repository';
import { TradeAnalysisRepository } from './repositories/trade-analysis.repository';
import { TradeRepository } from './repositories/trade.repository';

@Injectable()
class DatabaseLifecycle implements OnApplicationShutdown {
  constructor(@Inject(DATABASE) private readonly db: Db) {}
  onApplicationShutdown(): void {
    this.db.close();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: DATABASE,
      useFactory: (cfg: AppConfig) => openDatabase(cfg.DATABASE_PATH),
      inject: [APP_CONFIG],
    },
    DatabaseLifecycle,
    PositionRepository,
    OrderRepository,
    TradeRepository,
    EventRepository,
    StateRepository,
    TradeAnalysisRepository,
  ],
  exports: [
    DATABASE,
    PositionRepository,
    OrderRepository,
    TradeRepository,
    TradeAnalysisRepository,
    EventRepository,
    StateRepository,
  ],
})
export class PersistenceModule {}

export { DATABASE };
