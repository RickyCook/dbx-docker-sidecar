import { z } from 'zod';

// Field defaults per official image documentation
// (hub.docker.com/_/postgres, hub.docker.com/_/mysql, hub.docker.com/_/mariadb).
// Every db type lists only what it can supply reliably; anything missing
// falls through the merge chain (defaults → env → labels) to zod validation.
export const DEFAULT_CONFIG: ReadonlyMap<string, DbTypeConfig> = new Map([
  [
    'postgres',
    {
      dbType: 'postgres',
      port: 5432,
      username: 'postgres',
      password: '',
      database: 'postgres',
    },
  ],
  ['mysql', { dbType: 'mysql', port: 3306, username: 'root', password: '', database: null }],
  ['mariadb', { dbType: 'mysql', port: 3306, username: 'root', password: '', database: null }],
]);

export const DbTypeConfigSchema = z.object({
  dbType: z.string().min(1),
  // Required: no default can be invented for an arbitrary image.
  port: z.number().int().positive(),
  username: z.string(),
  password: z.string(),
  database: z.string().nullable(),
});

export type DbTypeConfig = z.infer<typeof DbTypeConfigSchema>;

// Port and credentials are the only truly required outputs; username and
// password carry no default requirement, database may be null.
export const MergedConfigSchema = z.object({
  dbType: z.string().min(1),
  port: z.number().int().positive(),
  username: z.string().default(''),
  password: z.string().default(''),
  database: z.string().nullable().default(null),
});

export type MergedConfig = z.infer<typeof MergedConfigSchema>;

export const ENABLE_VALUES = new Set(['true', '1']);

export interface LabelOverrides {
  readonly dbType?: string;
  readonly name?: string;
  readonly host?: string;
  readonly port?: number;
  readonly username?: string;
  readonly password?: string;
  readonly database?: string;
}

const LABEL_FIELDS = [
  'db_type',
  'name',
  'host',
  'port',
  'username',
  'password',
  'database',
] as const;

const LABEL_KEY_TO_FIELD = new Map<string, keyof LabelOverrides>([
  ['db_type', 'dbType'],
  ['name', 'name'],
  ['host', 'host'],
  ['username', 'username'],
  ['password', 'password'],
  ['database', 'database'],
]);

export interface ParsedLabels {
  readonly enabled: boolean;
  readonly overrides: LabelOverrides;
}

export function parseLabels(
  labels: Readonly<Record<string, string>>,
  prefix: string,
): ParsedLabels {
  const enableValue = labels[prefix];
  const overrides: Record<string, string | number> = {};
  for (const field of LABEL_FIELDS) {
    const raw = labels[`${prefix}.${field}`];
    if (raw === undefined) {
      continue;
    }
    if (field === 'port') {
      overrides.port = Number.parseInt(raw, 10);
    } else {
      overrides[LABEL_KEY_TO_FIELD.get(field) ?? ''] = raw;
    }
  }
  // SAFETY: the only keys ever inserted into overrides are the LABEL_FIELDS
  // values (port parsed to number) and their LABEL_KEY_TO_FIELD images, which
  // are exactly the members of LabelOverrides, all guaranteed present.
  return {
    enabled: enableValue !== undefined && ENABLE_VALUES.has(enableValue.toLowerCase()),
    overrides: overrides as LabelOverrides,
  };
}

export type DetectionResult =
  | { readonly ok: true; readonly dbType: string }
  | { readonly ok: false; readonly reason: string };

const ENV_HINTS: readonly { readonly dbType: string; readonly prefixes: readonly string[] }[] = [
  { dbType: 'postgres', prefixes: ['POSTGRES_'] },
  { dbType: 'mariadb', prefixes: ['MARIADB_'] },
  { dbType: 'mysql', prefixes: ['MYSQL_'] },
];

const IMAGE_HINTS: readonly { readonly dbType: string; readonly substrings: readonly string[] }[] =
  [
    { dbType: 'postgres', substrings: ['postgres'] },
    { dbType: 'mariadb', substrings: ['mariadb', 'maria'] },
    { dbType: 'mysql', substrings: ['mysql'] },
  ];

// Detection cascade: env vars → image-name substring → db_type label.
// The db_type label sits last but still rescues otherwise-undetectable
// containers before a skip is produced.
export function detectDbType(
  image: string,
  env: Readonly<Record<string, string>>,
  overrideDbType: string | undefined,
): DetectionResult {
  const envKeys = Object.keys(env);
  for (const hint of ENV_HINTS) {
    if (envKeys.some((key) => hint.prefixes.some((prefix) => key.startsWith(prefix)))) {
      return { ok: true, dbType: hint.dbType };
    }
  }
  const imageRef = image.toLowerCase();
  for (const hint of IMAGE_HINTS) {
    if (hint.substrings.some((substring) => imageRef.includes(substring))) {
      return { ok: true, dbType: hint.dbType };
    }
  }
  if (overrideDbType !== undefined && overrideDbType !== '') {
    return { ok: true, dbType: overrideDbType };
  }
  return {
    ok: false,
    reason: 'no engine detected: none of env vars, image name, or db_type label matched',
  };
}

// First-wins lookup along a per-type fallback chain, e.g. mariadb reads
// MARIADB_PASSWORD before MYSQL_PASSWORD.
function firstEnv(
  env: Readonly<Record<string, string>>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = env[key];
    if (value !== undefined && value !== '') {
      return value;
    }
  }
  return undefined;
}

function defined(...candidates: readonly (string | null | undefined)[]): string | null | undefined {
  for (const candidate of candidates) {
    if (candidate !== undefined) {
      return candidate;
    }
  }
  return undefined;
}

// Env-derived pieces of the config; every field is optional because the
// merge fills holes from type defaults and then labels.
export interface EnvConfig {
  readonly username?: string | undefined;
  readonly password?: string | undefined;
  readonly database?: string | null | undefined;
}

export function envConfig(dbType: string, env: Readonly<Record<string, string>>): EnvConfig {
  switch (dbType) {
    case 'postgres': {
      const user = firstEnv(env, ['POSTGRES_USER']);
      return {
        username: user ?? 'postgres',
        password: firstEnv(env, ['POSTGRES_PASSWORD']) ?? '',
        database: defined(firstEnv(env, ['POSTGRES_DB']), user, 'postgres'),
      };
    }
    case 'mariadb': {
      const database = firstEnv(env, ['MARIADB_DATABASE', 'MYSQL_DATABASE']) ?? null;
      const rootPassword = firstEnv(env, ['MARIADB_ROOT_PASSWORD', 'MYSQL_ROOT_PASSWORD']);
      if (rootPassword !== undefined) {
        return { username: 'root', password: rootPassword, database };
      }
      return {
        username: firstEnv(env, ['MARIADB_USER', 'MYSQL_USER']),
        password: firstEnv(env, ['MARIADB_PASSWORD', 'MYSQL_PASSWORD']),
        database,
      };
    }
    case 'mysql': {
      const database = firstEnv(env, ['MYSQL_DATABASE']) ?? null;
      const rootPassword = firstEnv(env, ['MYSQL_ROOT_PASSWORD']);
      if (rootPassword !== undefined) {
        return { username: 'root', password: rootPassword, database };
      }
      return {
        username: firstEnv(env, ['MYSQL_USER']),
        password: firstEnv(env, ['MYSQL_PASSWORD']),
        database,
      };
    }
    default:
      return {};
  }
}

// Merge order: type defaults ← env-derived ← label overrides, then zod
// checks that everything a dbx connection requires is present (port is the
// field most likely to be missing for an unlabeled exotic db type).
export type MergedResult =
  | { readonly ok: true; readonly config: MergedConfig }
  | { readonly ok: false; readonly reason: string };

function issueReason(
  issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[],
): string {
  return issues
    .map((issue) => `${issue.path.join('.') || 'connection'}: ${issue.message}`)
    .join('; ');
}

export function mergedConfig(
  dbType: string,
  env: Readonly<Record<string, string>>,
  overrides: LabelOverrides,
): MergedResult {
  const typeDefault = DEFAULT_CONFIG.get(dbType);
  const envDerived = envConfig(dbType, env);
  const parsed = MergedConfigSchema.safeParse({
    dbType: typeDefault?.dbType ?? dbType,
    port: firstOf(overrides.port, typeDefault?.port),
    username: firstOf(overrides.username, envDerived.username, typeDefault?.username),
    password: firstOf(overrides.password, envDerived.password, typeDefault?.password),
    database: firstOfNullable(overrides.database, envDerived.database, typeDefault?.database),
  });
  if (!parsed.success) {
    return {
      ok: false,
      reason: `connection config incomplete: ${issueReason(parsed.error.issues)}`,
    };
  }
  return { ok: true, config: parsed.data };
}

function firstOf(
  ...candidates: readonly (string | number | undefined)[]
): string | number | undefined {
  for (const candidate of candidates) {
    if (candidate !== undefined) {
      return candidate;
    }
  }
  return undefined;
}

function firstOfNullable(...candidates: readonly (string | null | undefined)[]): string | null {
  for (const candidate of candidates) {
    if (candidate !== undefined) {
      return candidate;
    }
  }
  return null;
}
