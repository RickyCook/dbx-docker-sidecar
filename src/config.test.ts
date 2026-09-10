import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from './config.js';

function env(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return { NODE_ENV: undefined, ...overrides } as NodeJS.ProcessEnv;
}

describe('loadConfig', () => {
  it('fails fast without DBX_PASSWORD', () => {
    expect(() => loadConfig(env({}))).toThrow(ConfigError);
    expect(() => loadConfig(env({ DBX_PASSWORD: '' }))).toThrow(
      'Missing required environment variable: DBX_PASSWORD',
    );
  });

  it('applies documented defaults', () => {
    const c = loadConfig(env({ DBX_PASSWORD: 'secret' }));
    expect(c.DBX_URL).toBe('http://dbx:4224');
    expect(c.DBX_PASSWORD).toBe('secret');
    expect(c.LABEL_PREFIX).toBe('com.thatpanda.show-in-dbx');
    expect(c.RESYNC_INTERVAL_MS).toBe(60_000);
    expect(c.EVENT_DEBOUNCE_MS).toBe(1_500);
  });

  it('trims trailing slashes from DBX_URL', () => {
    const c = loadConfig(env({ DBX_PASSWORD: 'x', DBX_URL: 'http://dbx:4224///' }));
    expect(c.DBX_URL).toBe('http://dbx:4224');
  });

  it('respects env overrides', () => {
    const c = loadConfig(
      env({
        DBX_PASSWORD: 'x',
        DBX_URL: 'http://other:4224/',
        LABEL_PREFIX: 'my.label',
        RESYNC_INTERVAL_MS: '5000',
        EVENT_DEBOUNCE_MS: '200',
      }),
    );
    expect(c.DBX_URL).toBe('http://other:4224');
    expect(c.LABEL_PREFIX).toBe('my.label');
    expect(c.RESYNC_INTERVAL_MS).toBe(5_000);
    expect(c.EVENT_DEBOUNCE_MS).toBe(200);
  });

  it('rejects non-positive or non-integer intervals', () => {
    for (const bad of ['0', '-1', '1.5', 'abc', ' ']) {
      expect(() => loadConfig(env({ DBX_PASSWORD: 'x', RESYNC_INTERVAL_MS: bad }))).toThrow(
        ConfigError,
      );
    }
  });
});
