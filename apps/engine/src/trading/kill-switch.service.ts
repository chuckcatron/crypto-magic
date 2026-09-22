import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { APP_CONFIG } from '../config/tokens';
import type { AppConfig } from '../config/config.schema';
import { EventRepository } from '../persistence/repositories/event.repository';
import { childLogger } from '../common/logger';

/**
 * The stop button.
 *
 * Backed by a file on disk rather than memory, for three reasons: it survives a
 * restart (a bot that forgets it was halted is worse than no halt at all), it
 * can be engaged without the API — `touch data/KILL_SWITCH` — and it can be
 * engaged while the process is wedged.
 *
 * Engaging it blocks new entries. It never blocks an exit.
 */
@Injectable()
export class KillSwitchService implements OnModuleInit {
  private readonly log = childLogger('kill-switch');

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly events: EventRepository,
  ) {}

  onModuleInit(): void {
    if (this.isEngaged()) {
      this.log.warn(
        { file: this.config.KILL_SWITCH_FILE },
        'kill switch is engaged at startup; no new positions will be opened',
      );
    }
  }

  isEngaged(): boolean {
    return existsSync(this.config.KILL_SWITCH_FILE);
  }

  engage(reason: string): void {
    const path = this.config.KILL_SWITCH_FILE;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${new Date().toISOString()}\n${reason}\n`, 'utf8');
    this.log.error({ reason }, 'KILL SWITCH ENGAGED — entries blocked');
    this.events.append({ level: 'error', kind: 'kill_switch', message: `engaged: ${reason}` });
  }

  release(): void {
    if (!this.isEngaged()) return;
    rmSync(this.config.KILL_SWITCH_FILE, { force: true });
    this.log.warn('kill switch released; entries permitted again');
    this.events.append({ level: 'warn', kind: 'kill_switch', message: 'released' });
  }
}
