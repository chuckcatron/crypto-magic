import type { Alert, NotificationChannel } from './types';

export interface DeliveryResult {
  readonly channel: string;
  readonly ok: boolean;
  readonly error?: string;
}

/**
 * Sends to every configured channel, independently.
 *
 * Channels are tried in parallel and one failing never prevents another from
 * delivering — the entire point of configuring two is that one of them might be
 * down when it matters. Nothing here throws; the caller gets a per-channel
 * result and decides what to record.
 */
export class FanoutNotifier {
  constructor(private readonly channels: NotificationChannel[]) {}

  get channelNames(): string[] {
    return this.channels.map((c) => c.name);
  }

  get isConfigured(): boolean {
    return this.channels.length > 0;
  }

  async send(alert: Alert): Promise<DeliveryResult[]> {
    return Promise.all(
      this.channels.map(async (channel): Promise<DeliveryResult> => {
        try {
          await channel.send(alert);
          return { channel: channel.name, ok: true };
        } catch (error) {
          return {
            channel: channel.name,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
  }
}
