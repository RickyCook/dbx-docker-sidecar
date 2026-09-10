import { type Logger, pino } from 'pino';

// Plain stdout JSON always; pretty output comes from piping through the
// pino-pretty CLI (`pnpm dev`) because worker-based transports cannot be
// resolved inside an esbuild bundle.
export const log: Logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: ['password', 'dbxPassword', 'DBX_PASSWORD'],
});

export function childLogger(component: string): Logger {
  return log.child({ component });
}
