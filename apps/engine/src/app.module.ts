import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { ExchangeModule } from './exchange/exchange.module';
import { InsightModule } from './insight/insight.module';
import { PersistenceModule } from './persistence/persistence.module';
import { TradingModule } from './trading/trading.module';

@Module({
  imports: [ConfigModule, PersistenceModule, ExchangeModule, InsightModule, TradingModule],
})
export class AppModule {}
