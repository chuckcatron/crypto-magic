import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config/config.schema';
import { configSchema } from '../config/config.schema';
import { PUBLIC_CONFIG_KEYS } from './api.controller';

/** Anything whose name suggests it grants access to something. */
const SECRET_SHAPED = /KEY|TOKEN|SECRET|WEBHOOK|PRIVATE|PASSWORD|TOPIC|CHAT_ID|_ACK|CREDENTIAL|PING_URL/i;

describe('public config allowlist', () => {
  it('contains nothing that looks like a credential', () => {
    const leaks = PUBLIC_CONFIG_KEYS.filter((key) => SECRET_SHAPED.test(key));
    // LLM_MAX_TOKENS is a number of tokens, not an auth token — the only
    // legitimate match, and it is not on the list anyway.
    expect(leaks).toEqual([]);
  });

  it('hides every secret-shaped field the schema defines — including ones added later', () => {
    // This is the regression the review found: secrets added to the config
    // after the endpoint was written were served in plain text. Enumerate the
    // live schema so a new one is caught the day it is added.
    const shape = (configSchema as unknown as { _def: { schema: { shape: Record<string, unknown> } } })
      ._def.schema.shape;
    const secretFields = Object.keys(shape).filter(
      (key) => SECRET_SHAPED.test(key) && key !== 'LLM_MAX_TOKENS',
    );

    expect(secretFields.length).toBeGreaterThanOrEqual(8);
    for (const field of secretFields) {
      expect(PUBLIC_CONFIG_KEYS as readonly string[]).not.toContain(field);
    }
  });

  it('never emits a configured secret VALUE, whatever the key is called', () => {
    const secrets = {
      COINBASE_API_KEY_NAME: 'organizations/x/apiKeys/SECRET-KEYNAME',
      COINBASE_API_PRIVATE_KEY: 'SECRET-PEM-VALUE',
      TELEGRAM_BOT_TOKEN: '123:SECRET-TELEGRAM',
      TELEGRAM_CHAT_ID: '4242',
      DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/SECRET-DISCORD',
      NTFY_TOPIC: 'secret-ntfy-topic',
      NEWS_ENABLED: 'true',
      CRYPTOPANIC_API_KEY: 'SECRET-CRYPTOPANIC',
      DEADMAN_PING_URL: 'https://hc-ping.com/SECRET-DEADMAN-UUID',
      LOG_LEVEL: 'fatal',
    };
    const config = loadConfig(secrets as unknown as NodeJS.ProcessEnv);

    const exposed: Record<string, unknown> = {};
    for (const key of PUBLIC_CONFIG_KEYS) exposed[key] = config[key];
    const serialized = JSON.stringify(exposed);

    for (const [key, value] of Object.entries(secrets)) {
      if (['NEWS_ENABLED', 'LOG_LEVEL'].includes(key)) continue;
      expect(serialized, `${key} leaked`).not.toContain(value);
    }
  });
});
