import { z } from 'zod';

export class ConfigError extends Error {}

function unsetIfEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

const positiveIntEnv = z.preprocess(unsetIfEmpty, z.coerce.number().int().positive());

export const ConfigSchema = z.object({
  DBX_URL: z.preprocess(
    unsetIfEmpty,
    z
      .string()
      .default('http://dbx:4224')
      .transform((url) => url.replace(/\/+$/, '')),
  ),
  DBX_PASSWORD: z.string().min(1, 'Missing required environment variable: DBX_PASSWORD'),
  LABEL_PREFIX: z.preprocess(unsetIfEmpty, z.string().default('com.thatpanda.show-in-dbx')),
  RESYNC_INTERVAL_MS: z.preprocess(unsetIfEmpty, positiveIntEnv.default(60_000)),
  EVENT_DEBOUNCE_MS: z.preprocess(unsetIfEmpty, positiveIntEnv.default(1_500)),
});

export type SidecarConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SidecarConfig {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((issue) => issue.message).join('; '));
  }
  return parsed.data;
}
