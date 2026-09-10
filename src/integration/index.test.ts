import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import esbuild from 'esbuild';
import { afterAll, expect, it } from 'vitest';

const entry = new URL('../index.ts', import.meta.url).pathname;
const outfile = `${process.env.TMPDIR ?? '/tmp'}/sidecar-log-check.cjs`;

esbuild.buildSync({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile,
  allowOverwrite: true,
  external: ['cpu-features'],
});

afterAll(() => {
  fs.rmSync(outfile, { force: true });
});

it('logs start line, redacts the password, and shuts down cleanly on SIGTERM', async () => {
  const child = spawn(process.execPath, [outfile], {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      DBX_PASSWORD: 'hunter2-super-secret',
      LOG_LEVEL: 'info',
    },
    // No dbx is reachable here: the app logs its start line, then sits in
    // the boot-retry loop until the test's SIGTERM.
  });
  let stdout = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  const exit = new Promise<number>((resolve) => {
    child.on('exit', (code) => resolve(code ?? 1));
  });
  await delay(2_000);
  child.kill('SIGTERM');
  const code = await Promise.race([exit, delay(6_000).then(() => -1)]);
  expect(code).toBe(0);
  expect(stdout).toContain('"msg":"dbx-docker-sidecar starting"');
  expect(stdout).toContain('com.thatpanda.show-in-dbx');
  expect(stdout).toContain('http://dbx:4224');
  expect(stdout).not.toContain('hunter2-super-secret');
  expect(stdout).toContain('"msg":"shutting down"');
  expect(stdout).toContain('"msg":"reconciler stopped"');
}, 20_000);
