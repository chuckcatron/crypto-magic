import { Global, Module } from '@nestjs/common';
import {
  AlertPolicy,
  DiscordChannel,
  FanoutNotifier,
  NtfyChannel,
  TelegramChannel,
  type NotificationChannel,
} from '@crypto-magic/notify';
import { APP_CONFIG } from '../config/tokens';
import type { AppConfig } from '../config/config.schema';
import { childLogger } from '../common/logger';
import { ALERT_POLICY, NOTIFIER } from './tokens';

/** Build whichever channels are configured. None configured = alerting is off. */
export function createNotifier(config: AppConfig): FanoutNotifier {
  const channels: NotificationChannel[] = [];

  if (config.DISCORD_WEBHOOK_URL) channels.push(new DiscordChannel(config.DISCORD_WEBHOOK_URL));
  if (config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID) {
    channels.push(new TelegramChannel(config.TELEGRAM_BOT_TOKEN, config.TELEGRAM_CHAT_ID));
  }
  if (config.NTFY_TOPIC) channels.push(new NtfyChannel(config.NTFY_TOPIC, config.NTFY_SERVER));

  if (channels.length === 0) {
    childLogger('alerts').warn(
      'no alert channels configured — a 24/7 bot with no alerting is an unobserved bot',
    );
  }
  return new FanoutNotifier(channels);
}

export function createAlertPolicy(config: AppConfig): AlertPolicy {
  return new AlertPolicy({
    minSeverity: config.ALERT_MIN_SEVERITY,
    cooldownSeconds: config.ALERT_COOLDOWN_SECONDS,
    maxPerHour: config.ALERT_MAX_PER_HOUR,
  });
}

@Global()
@Module({
  providers: [
    { provide: NOTIFIER, useFactory: createNotifier, inject: [APP_CONFIG] },
    { provide: ALERT_POLICY, useFactory: createAlertPolicy, inject: [APP_CONFIG] },
  ],
  exports: [NOTIFIER, ALERT_POLICY],
})
export class AlertModule {}
