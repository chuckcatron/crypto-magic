import { Module } from '@nestjs/common';
import { StatusController } from './api/status.controller';
import { FUTURES_CONFIG, loadConfig, type FuturesConfig } from './config/config';
import { CANDLE_SOURCE, CoinbaseCandleSource } from './market/candle-source';
import { ALERTER, NotifyAlerter } from './paper/alerts';
import { CLOCK, PaperTraderService } from './paper/paper-trader.service';
import { PaperStore } from './paper/store';

@Module({
  controllers: [StatusController],
  providers: [
    { provide: FUTURES_CONFIG, useFactory: () => loadConfig() },
    {
      provide: PaperStore,
      useFactory: (config: FuturesConfig) => PaperStore.open(config.FUTURES_DB_PATH),
      inject: [FUTURES_CONFIG],
    },
    { provide: CANDLE_SOURCE, useFactory: () => new CoinbaseCandleSource() },
    {
      provide: ALERTER,
      useFactory: (config: FuturesConfig) => NotifyAlerter.fromConfig(config),
      inject: [FUTURES_CONFIG],
    },
    { provide: CLOCK, useValue: () => Math.floor(Date.now() / 1000) },
    PaperTraderService,
  ],
})
export class AppModule {}
