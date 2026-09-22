import { Test, type TestingModule } from '@nestjs/testing';
import { ScheduleModule } from '@nestjs/schedule';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AlertPolicy, FanoutNotifier, type Alert, type NotificationChannel } from '@crypto-magic/notify';
import { APP_CONFIG } from '../config/tokens';
import { loadConfig, type AppConfig } from '../config/config.schema';
import { openDatabase } from '../persistence/database';
import { DATABASE } from '../persistence/tokens';
import { EventRepository } from '../persistence/repositories/event.repository';
import { PositionRepository } from '../persistence/repositories/position.repository';
import { StateRepository } from '../persistence/repositories/state.repository';
import { TradeRepository } from '../persistence/repositories/trade.repository';
import { ALERT_POLICY, NOTIFIER } from './tokens';
import { AlertService } from './alert.service';

class RecordingChannel implements NotificationChannel {
  readonly name = 'recording';
  sent: Alert[] = [];
  failing = false;
  async send(alert: Alert): Promise<void> {
    if (this.failing) throw new Error('channel down');
    this.sent.push(alert);
  }
}

/** Let the queued, deliberately-deferred delivery run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('AlertService', () => {
  let moduleRef: TestingModule;
  let service: AlertService;
  let events: EventRepository;
  let channel: RecordingChannel;

  const build = async (overrides: Record<string, string> = {}) => {
    const config: AppConfig = loadConfig({
      TRADING_MODE: 'paper',
      DATABASE_PATH: ':memory:',
      LOG_LEVEL: 'fatal',
      NTFY_TOPIC: 'test-topic',
      HEARTBEAT_ENABLED: 'false',
      ...overrides,
    } as NodeJS.ProcessEnv);

    channel = new RecordingChannel();

    moduleRef = await Test.createTestingModule({
      imports: [ScheduleModule.forRoot()],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: DATABASE, useFactory: () => openDatabase(':memory:') },
        { provide: NOTIFIER, useValue: new FanoutNotifier([channel]) },
        {
          provide: ALERT_POLICY,
          useValue: new AlertPolicy({
            minSeverity: config.ALERT_MIN_SEVERITY,
            cooldownSeconds: config.ALERT_COOLDOWN_SECONDS,
            maxPerHour: config.ALERT_MAX_PER_HOUR,
          }),
        },
        EventRepository,
        PositionRepository,
        TradeRepository,
        StateRepository,
        AlertService,
      ],
    }).compile();

    service = moduleRef.get(AlertService);
    events = moduleRef.get(EventRepository);
    service.onApplicationBootstrap();
  };

  beforeEach(() => build());
  afterEach(async () => moduleRef?.close());

  it('alerts when the kill switch engages', async () => {
    events.append({ level: 'error', kind: 'kill_switch', message: 'engaged: slippage breach' });
    await settle();

    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0]!.severity).toBe('critical');
    expect(channel.sent[0]!.title).toContain('ENGAGED');
  });

  it('alerts on a trading halt', async () => {
    events.append({ level: 'warn', kind: 'halt', message: 'entries halted: daily_loss_limit' });
    await settle();
    expect(channel.sent[0]!.severity).toBe('critical');
  });

  it('alerts on a reconciliation mismatch but not a clean reconcile', async () => {
    events.append({ level: 'info', kind: 'reconciliation', message: 'reconciled 2 position(s)' });
    events.append({ level: 'error', kind: 'reconciliation', message: 'reconciled 2 position(s)' });
    await settle();

    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0]!.severity).toBe('critical');
  });

  it('stays quiet for normal operation', async () => {
    events.append({ level: 'info', kind: 'signal', message: 'ENTER_LONG BTC-USD' });
    events.append({ level: 'info', kind: 'risk_rejected', message: 'sizer refused: too small' });
    events.append({ level: 'info', kind: 'cycle_completed', message: 'evaluated closed bar' });
    events.append({ level: 'info', kind: 'trade_analysed', message: 'sound process' });
    await settle();

    // Alerting on routine behaviour is how a channel gets muted.
    expect(channel.sent).toHaveLength(0);
  });

  it('does not alert on info events at the default threshold', async () => {
    events.append({ level: 'info', kind: 'position_opened', message: 'opened BTC-USD' });
    await settle();
    expect(channel.sent).toHaveLength(0);
  });

  describe('flood protection', () => {
    it('collapses a failure repeating every tick into one alert', async () => {
      for (let i = 0; i < 40; i++) {
        events.append({ level: 'error', kind: 'error', message: 'failed to process BTC-USD: HTTP 403' });
      }
      await settle();

      expect(channel.sent).toHaveLength(1);
      expect(service.status.dropped).toBe(39);
    });

    it('treats the same condition with different numbers as one alert', async () => {
      events.append({ level: 'error', kind: 'error', message: 'price 61240.55 below stop' });
      events.append({ level: 'error', kind: 'error', message: 'price 59180.20 below stop' });
      await settle();
      expect(channel.sent).toHaveLength(1);
    });

    it('still delivers a critical during a flood of warnings', async () => {
      for (let i = 0; i < 60; i++) {
        events.append({ level: 'error', kind: 'error', message: `distinct failure ${i}` });
      }
      events.append({ level: 'error', kind: 'kill_switch', message: 'engaged: something bad' });
      await settle();

      const titles = channel.sent.map((a) => a.title);
      expect(titles).toContain('Kill switch ENGAGED');
    });
  });

  describe('isolation from trading', () => {
    it('never throws out of append, even when every channel is down', async () => {
      channel.failing = true;
      expect(() =>
        events.append({ level: 'error', kind: 'kill_switch', message: 'engaged' }),
      ).not.toThrow();
      await settle();
      expect(service.status.recent.at(-1)?.results[0]?.ok).toBe(false);
    });

    it('returns from append immediately rather than waiting on delivery', () => {
      // Delivery is deferred to a later tick; nothing is sent synchronously.
      events.append({ level: 'error', kind: 'kill_switch', message: 'engaged' });
      expect(channel.sent).toHaveLength(0);
    });
  });

  it('sends a test alert that bypasses the threshold and cooldown', async () => {
    await service.sendTestAlert();
    await service.sendTestAlert();
    expect(channel.sent).toHaveLength(2);
    expect(channel.sent[0]!.title).toBe('Test alert');
  });

  it('reports its own state for the dashboard', async () => {
    events.append({ level: 'error', kind: 'kill_switch', message: 'engaged' });
    await settle();

    const status = service.status;
    expect(status.enabled).toBe(true);
    expect(status.channels).toEqual(['recording']);
    expect(status.sent).toBe(1);
  });

  describe('with no channels configured', () => {
    beforeEach(async () => {
      await moduleRef.close();
      await build({ NTFY_TOPIC: '' });
      // Rebuild with a genuinely empty fanout.
      await moduleRef.close();
      const config = loadConfig({
        TRADING_MODE: 'paper',
        DATABASE_PATH: ':memory:',
        LOG_LEVEL: 'fatal',
        HEARTBEAT_ENABLED: 'false',
      } as NodeJS.ProcessEnv);
      moduleRef = await Test.createTestingModule({
        imports: [ScheduleModule.forRoot()],
        providers: [
          { provide: APP_CONFIG, useValue: config },
          { provide: DATABASE, useFactory: () => openDatabase(':memory:') },
          { provide: NOTIFIER, useValue: new FanoutNotifier([]) },
          { provide: ALERT_POLICY, useValue: new AlertPolicy() },
          EventRepository,
          PositionRepository,
          TradeRepository,
          StateRepository,
          AlertService,
        ],
      }).compile();
      service = moduleRef.get(AlertService);
      events = moduleRef.get(EventRepository);
      service.onApplicationBootstrap();
    });

    it('reports itself disabled and never subscribes', () => {
      expect(service.status.enabled).toBe(false);
      expect(() => events.append({ level: 'error', kind: 'kill_switch', message: 'x' })).not.toThrow();
    });
  });
});
