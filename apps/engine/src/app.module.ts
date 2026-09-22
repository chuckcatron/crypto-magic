import { Module } from '@nestjs/common';
import { AlertModule } from './alerts/alert.module';
import { ConfigModule } from './config/config.module';
import { ExchangeModule } from './exchange/exchange.module';
import { InsightModule } from './insight/insight.module';
import { PersistenceModule } from './persistence/persistence.module';
import { TradingModule } from './trading/trading.module';

@Module({
  imports: [
    ConfigModule,
    PersistenceModule,
    ExchangeModule,
    AlertModule,
    InsightModule,
    TradingModule,
  ],
})
export class AppModule {}
