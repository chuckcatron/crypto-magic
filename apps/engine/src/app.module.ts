import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { ExchangeModule } from './exchange/exchange.module';
import { PersistenceModule } from './persistence/persistence.module';
import { TradingModule } from './trading/trading.module';

@Module({
  imports: [ConfigModule, PersistenceModule, ExchangeModule, TradingModule],
})
export class AppModule {}
