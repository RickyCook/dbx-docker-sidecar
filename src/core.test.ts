import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CONFIG,
  detectDbType,
  envConfig,
  type LabelOverrides,
  mergedConfig,
  parseLabels,
} from './detection.js';
import { computeDesired, connectionId, type DesiredState, diffState } from './reconcile-core.js';
import type { ContainerSnapshot } from './snapshot.js';

const PREFIX = 'com.thatpanda.show-in-dbx';
const LABEL = 'com.thatpanda.show-in-dbx';

describe('parseLabels', () => {
  it('enables on true and 1', () => {
    expect(parseLabels({ [PREFIX]: 'true' }, PREFIX).enabled).toBe(true);
    expect(parseLabels({ [PREFIX]: '1' }, PREFIX).enabled).toBe(true);
  });

  it('treats false, other values, and absence as disabled', () => {
    expect(parseLabels({ [PREFIX]: 'false' }, PREFIX).enabled).toBe(false);
    expect(parseLabels({ [PREFIX]: 'yes' }, PREFIX).enabled).toBe(false);
    expect(parseLabels({}, PREFIX).enabled).toBe(false);
  });

  it('collects field overrides with camelCase keys and parsed ports', () => {
    const parsed = parseLabels(
      {
        [PREFIX]: 'true',
        [`${PREFIX}.db_type`]: 'redis',
        [`${PREFIX}.name`]: 'Cache',
        [`${PREFIX}.host`]: 'redis.example',
        [`${PREFIX}.port`]: '6379',
        [`${PREFIX}.username`]: 'u',
        [`${PREFIX}.password`]: 'p',
        [`${PREFIX}.database`]: 'd',
      },
      PREFIX,
    );
    expect(parsed.overrides).toStrictEqual({
      dbType: 'redis',
      name: 'Cache',
      host: 'redis.example',
      port: 6379,
      username: 'u',
      password: 'p',
      database: 'd',
    } satisfies LabelOverrides);
  });
});

describe('detectDbType', () => {
  it('detects postgres first from env', () => {
    expect(detectDbType('bogus:latest', { POSTGRES_PASSWORD: 'x' }, undefined)).toStrictEqual({
      ok: true,
      dbType: 'postgres',
    });
  });

  it('detects mysql from MYSQL_ env', () => {
    expect(detectDbType('bogus:latest', { MYSQL_ROOT_PASSWORD: 'x' }, undefined)).toStrictEqual({
      ok: true,
      dbType: 'mysql',
    });
  });

  it('detects mariadb from MARIADB_ env ahead of image hints', () => {
    expect(detectDbType('mysql:8', { MARIADB_ROOT_PASSWORD: 'x' }, undefined)).toStrictEqual({
      ok: true,
      dbType: 'mariadb',
    });
  });

  it('falls back to image-name substrings, mariadb before mysql', () => {
    expect(detectDbType('postgres:16', {}, undefined)).toStrictEqual({
      ok: true,
      dbType: 'postgres',
    });
    expect(detectDbType('mariadb:11', {}, undefined)).toStrictEqual({
      ok: true,
      dbType: 'mariadb',
    });
    expect(detectDbType('bitnami/mysql:8', {}, undefined)).toStrictEqual({
      ok: true,
      dbType: 'mysql',
    });
  });

  it('uses the db_type label as the final chance before a skip', () => {
    expect(detectDbType('redis:7', {}, 'redis')).toStrictEqual({ ok: true, dbType: 'redis' });
  });

  it('skips with a reason when nothing matches', () => {
    expect(detectDbType('alpine:latest', {}, undefined)).toStrictEqual({
      ok: false,
      reason: 'no engine detected: none of env vars, image name, or db_type label matched',
    });
  });
});

describe('envConfig', () => {
  it('postgres: POSTGRES_ vars with documented defaults', () => {
    expect(envConfig('postgres', {})).toStrictEqual({
      username: 'postgres',
      password: '',
      database: 'postgres',
    });
    expect(
      envConfig('postgres', {
        POSTGRES_USER: 'app',
        POSTGRES_PASSWORD: 'secret',
        POSTGRES_DB: 'appdb',
      }),
    ).toStrictEqual({ username: 'app', password: 'secret', database: 'appdb' });
    expect(envConfig('postgres', { POSTGRES_USER: 'app' })).toStrictEqual({
      username: 'app',
      password: '',
      database: 'app',
    });
    expect(envConfig('postgres', { POSTGRES_PASSWORD: 'p' })).toStrictEqual({
      username: 'postgres',
      password: 'p',
      database: 'postgres',
    });
  });

  it('mysql: root path wins, user path otherwise', () => {
    expect(
      envConfig('mysql', { MYSQL_ROOT_PASSWORD: 'rootpass', MYSQL_DATABASE: 'data' }),
    ).toStrictEqual({
      username: 'root',
      password: 'rootpass',
      database: 'data',
    });
    expect(envConfig('mysql', { MYSQL_ROOT_PASSWORD: 'rootpass' })).toStrictEqual({
      username: 'root',
      password: 'rootpass',
      database: null,
    });
    expect(envConfig('mysql', { MYSQL_USER: 'app' })).toStrictEqual({
      username: 'app',
      password: undefined,
      database: null,
    });
    expect(envConfig('mysql', {})).toStrictEqual({
      username: undefined,
      password: undefined,
      database: null,
    });
  });

  it('mariadb: prefers MARIADB_ and falls back to MYSQL_', () => {
    expect(envConfig('mariadb', { MARIADB_ROOT_PASSWORD: 'm' })).toStrictEqual({
      username: 'root',
      password: 'm',
      database: null,
    });
    expect(envConfig('mariadb', { MYSQL_ROOT_PASSWORD: 'legacy' })).toStrictEqual({
      username: 'root',
      password: 'legacy',
      database: null,
    });
    expect(envConfig('mariadb', { MARIADB_USER: 'a', MYSQL_PASSWORD: 'legacy-pw' })).toStrictEqual({
      username: 'a',
      password: 'legacy-pw',
      database: null,
    });
    expect(envConfig('mariadb', { MARIADB_PASSWORD: 'm', MYSQL_USER: 'ignored' })).toStrictEqual({
      username: 'ignored',
      password: 'm',
      database: null,
    });
  });

  it('unknown db types get no env-derived config', () => {
    expect(envConfig('redis', {})).toStrictEqual({});
  });
});

describe('mergedConfig', () => {
  it('merges type defaults ← env ← labels in precedence order', () => {
    expect(mergedConfig('postgres', { POSTGRES_DB: 'envdb' }, {})).toStrictEqual({
      ok: true,
      config: {
        dbType: 'postgres',
        port: 5432,
        username: 'postgres',
        password: '',
        database: 'envdb',
      },
    });
    expect(
      mergedConfig(
        'postgres',
        { POSTGRES_USER: 'envuser' },
        { username: 'label-user', port: 6543 },
      ),
    ).toStrictEqual({
      ok: true,
      config: {
        dbType: 'postgres',
        port: 6543,
        username: 'label-user',
        password: '',
        database: 'envuser',
      },
    });
    expect(mergedConfig('mariadb', {}, {})).toStrictEqual({
      ok: true,
      config: { dbType: 'mysql', port: 3306, username: 'root', password: '', database: null },
    });
  });

  it('fails when port is unavailable for an unlabeled exotic type', () => {
    expect(mergedConfig('redis', {}, {})).toStrictEqual({
      ok: false,
      reason:
        'connection config incomplete: port: Invalid input: expected number, received undefined',
    });
  });
});

describe('DEFAULT_CONFIG', () => {
  it('carries documented defaults per engine', () => {
    expect(DEFAULT_CONFIG.get('postgres')).toStrictEqual({
      dbType: 'postgres',
      port: 5432,
      username: 'postgres',
      password: '',
      database: 'postgres',
    });
    expect(DEFAULT_CONFIG.get('mysql')).toStrictEqual({
      dbType: 'mysql',
      port: 3306,
      username: 'root',
      password: '',
      database: null,
    });
    expect(DEFAULT_CONFIG.get('mariadb')).toStrictEqual({
      dbType: 'mysql',
      port: 3306,
      username: 'root',
      password: '',
      database: null,
    });
  });
});

function snapshot(overrides: Partial<ContainerSnapshot> & { name: string }): ContainerSnapshot {
  return {
    id: overrides.name,
    image: 'postgres:16',
    running: true,
    hostname: overrides.name,
    env: {},
    networks: [{ name: 'default', ip: '10.0.0.9' }],
    labels: { [LABEL]: 'true' },
    ...overrides,
  };
}

const SIDECAR = ['default'];

describe('connectionId', () => {
  it('is sha1 of the container name, 16 hex chars', () => {
    expect(connectionId('pg-a')).toBe(createHash('sha1').update('pg-a').digest('hex').slice(0, 16));
    expect(connectionId('pg-a')).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is stable across calls (recreate keeps the id)', () => {
    expect(connectionId('pg-a')).toBe(connectionId('pg-a'));
    expect(connectionId('pg-a')).not.toBe(connectionId('pg-b'));
  });
});

describe('computeDesired', () => {
  it('builds one connection per labeled container with defaults and ip host', () => {
    const desired = computeDesired([snapshot({ name: 'pg-a', env: { POSTGRES_PASSWORD: 'p' } })], {
      labelPrefix: PREFIX,
      sidecarNetworks: SIDECAR,
    });
    expect(desired.connections).toStrictEqual([
      {
        id: connectionId('pg-a'),
        name: 'pg-a',
        db_type: 'postgres',
        host: '10.0.0.9',
        port: 5432,
        username: 'postgres',
        password: 'p',
        database: 'postgres',
        save_password: true,
      },
    ]);
    expect(desired.skipped).toStrictEqual([]);
    expect(desired.attachments).toStrictEqual(['default']);
  });

  it('uses the shared-with-sidecar network for the host ip', () => {
    const desired = computeDesired(
      [
        snapshot({
          name: 'pg-a',
          networks: [
            { name: 'default', ip: '10.0.0.9' },
            { name: 'alpha', ip: '172.1.0.5' },
          ],
        }),
      ],
      { labelPrefix: PREFIX, sidecarNetworks: ['alpha'] },
    );
    expect(desired.connections[0]?.host).toBe('172.1.0.5');
    expect(desired.attachments).toStrictEqual(['alpha', 'default']);
  });

  it('stopped containers keep their connection with an FQDN host from Config.Hostname', () => {
    const desired = computeDesired(
      [
        snapshot({
          name: 'pg-stopped',
          hostname: 'a1b2c3',
          running: false,
          networks: [{ name: 'default' }],
        }),
      ],
      { labelPrefix: PREFIX, sidecarNetworks: SIDECAR },
    );
    expect(desired.connections).toHaveLength(1);
    expect(desired.connections[0]?.host).toBe('a1b2c3.default');
  });

  it('label overrides win over env-derived and type defaults (precedence)', () => {
    const desired = computeDesired(
      [
        snapshot({
          name: 'pg-a',
          env: { POSTGRES_PASSWORD: 'env-pw', POSTGRES_DB: 'env-db', POSTGRES_USER: 'env-user' },
          labels: {
            [LABEL]: 'true',
            [`${PREFIX}.username`]: 'label-user',
            [`${PREFIX}.password`]: 'label-pw',
            [`${PREFIX}.database`]: 'label-db',
            [`${PREFIX}.port`]: '6543',
          },
        }),
      ],
      { labelPrefix: PREFIX, sidecarNetworks: SIDECAR },
    );
    expect(desired.connections[0]).toMatchObject({
      username: 'label-user',
      password: 'label-pw',
      database: 'label-db',
      port: 6543,
    });
  });

  it('uses default ports per engine and a .port override otherwise', () => {
    expect(
      computeDesired(
        [snapshot({ name: 'm', image: 'mysql:8', env: { MYSQL_ROOT_PASSWORD: 'x' } })],
        { labelPrefix: PREFIX, sidecarNetworks: SIDECAR },
      ).connections[0],
    ).toMatchObject({ db_type: 'mysql', port: 3306 });
    expect(
      computeDesired(
        [
          snapshot({
            name: 'r',
            image: 'redis:7',
            labels: { [LABEL]: 'true', [`${PREFIX}.db_type`]: 'redis', [`${PREFIX}.port`]: '6379' },
          }),
        ],
        { labelPrefix: PREFIX, sidecarNetworks: SIDECAR },
      ).connections,
    ).toHaveLength(1);
  });

  it('redis-style fully labeled configs pass through verbatim', () => {
    const desired = computeDesired(
      [
        snapshot({
          name: 'cache',
          image: 'redis:7',
          env: {},
          labels: {
            [LABEL]: 'true',
            [`${PREFIX}.db_type`]: 'redis',
            [`${PREFIX}.name`]: 'Cache',
            [`${PREFIX}.port`]: '6379',
            [`${PREFIX}.username`]: '',
            [`${PREFIX}.password`]: '',
          },
        }),
      ],
      { labelPrefix: PREFIX, sidecarNetworks: SIDECAR },
    );
    expect(desired.connections).toHaveLength(1);
    expect(desired.connections[0]).toMatchObject({
      db_type: 'redis',
      name: 'Cache',
      port: 6379,
      username: '',
      password: '',
    });
  });

  it('reports an unknown engine without a port label as a skip with a reason', () => {
    const desired = computeDesired(
      [
        snapshot({
          name: 'r',
          image: 'redis:7',
          labels: { [LABEL]: 'true', [`${PREFIX}.db_type`]: 'redis' },
        }),
      ],
      { labelPrefix: PREFIX, sidecarNetworks: SIDECAR },
    );
    expect(desired.connections).toHaveLength(0);
    expect(desired.skipped).toStrictEqual([
      {
        name: 'r',
        reason:
          'connection config incomplete: port: Invalid input: expected number, received undefined',
      },
    ]);
  });

  it('reports a non-enabling label as a skip with a reason', () => {
    const desired = computeDesired([snapshot({ name: 'junk', labels: { [LABEL]: 'false' } })], {
      labelPrefix: PREFIX,
      sidecarNetworks: SIDECAR,
    });
    expect(desired.skipped).toStrictEqual([
      { name: 'junk', reason: 'label not set to an enabling value (true/1)' },
    ]);
  });

  it('reports an undetectable engine as a skip with a reason', () => {
    const desired = computeDesired(
      [snapshot({ name: 'junk', image: 'alpine:latest', labels: { [LABEL]: 'true' } })],
      { labelPrefix: PREFIX, sidecarNetworks: SIDECAR },
    );
    expect(desired.skipped).toHaveLength(1);
    expect(desired.skipped[0]).toMatchObject({ name: 'junk' });
  });

  it('a skipped container never prevents other containers from syncing', () => {
    const desired = computeDesired(
      [snapshot({ name: 'junk', image: 'alpine:latest' }), snapshot({ name: 'pg-ok' })],
      { labelPrefix: PREFIX, sidecarNetworks: SIDECAR },
    );
    expect(desired.connections.map((connection) => connection.id)).toStrictEqual([
      connectionId('pg-ok'),
    ]);
    expect(desired.skipped.map((skip) => skip.name)).toStrictEqual(['junk']);
  });

  it('stopped containers still contribute networks to the attachment set', () => {
    const desired = computeDesired(
      [snapshot({ name: 'pg-off', running: false, hostname: '', networks: [{ name: 'dbnet' }] })],
      { labelPrefix: PREFIX, sidecarNetworks: SIDECAR },
    );
    expect(desired.attachments).toContain('dbnet');
    expect(desired.connections[0]?.host).toBe('pg-off.dbnet');
  });

  it('is deterministic: every field is a pure function of the snapshot', () => {
    const build = () =>
      computeDesired([snapshot({ name: 'pg-a', env: { POSTGRES_PASSWORD: 'p' } })], {
        labelPrefix: PREFIX,
        sidecarNetworks: SIDECAR,
      });
    expect(JSON.stringify(build())).toBe(JSON.stringify(build()));
  });
});

describe('diffState', () => {
  const desired = (): DesiredState =>
    computeDesired([snapshot({ name: 'pg-a', env: { POSTGRES_PASSWORD: 'p' } })], {
      labelPrefix: PREFIX,
      sidecarNetworks: SIDECAR,
    });

  it('is empty when the snapshot matches the current state exactly (idempotent)', () => {
    expect(
      diffState(desired(), {
        connections: desired().connections,
        dbNetworks: desired().attachments,
        sidecarNetworks: SIDECAR,
      }),
    ).toStrictEqual({ connectionChanges: [], networkChanges: [] });
  });

  it('recreate with a new ip → update-in-place (same id, new host)', () => {
    const current = {
      connections: desired().connections.map((c) => ({
        ...c,
        host: '10.0.0.old',
        name: 'old-name',
      })),
      dbNetworks: desired().attachments,
      sidecarNetworks: SIDECAR,
    };
    const state = diffState(desired(), current);
    expect(state.connectionChanges).toHaveLength(1);
    expect(state.connectionChanges[0]).toMatchObject({
      action: 'update',
      connection: { id: connectionId('pg-a'), host: '10.0.0.9', name: 'pg-a' },
    });
    expect(state.networkChanges).toStrictEqual([]);
  });

  it('destroyed container → remove entry flows from desired-absence only', () => {
    const gone = desired().connections.map((c) => ({
      ...c,
      id: connectionId('gone'),
      name: 'gone',
    }));
    const current = {
      connections: [...desired().connections, ...gone],
      dbNetworks: desired().attachments,
      sidecarNetworks: SIDECAR,
    };
    const state = diffState(desired(), current);
    expect(state.connectionChanges).toStrictEqual([{ action: 'remove', id: connectionId('gone') }]);
  });

  it('newly labeled container → add', () => {
    const current = {
      connections: [],
      dbNetworks: desired().attachments,
      sidecarNetworks: SIDECAR,
    };
    const state = diffState(desired(), current);
    expect(state.connectionChanges).toHaveLength(1);
    expect(state.connectionChanges[0]).toMatchObject({
      action: 'add',
      connection: { id: connectionId('pg-a') },
    });
  });

  it('networks: connects missing, disconnects stray, never disconnects sidecar own networks', () => {
    const state = diffState(desired(), {
      connections: [],
      dbNetworks: ['default', 'stale', 'extra'],
      sidecarNetworks: ['default'],
    });
    expect(state.networkChanges).toStrictEqual([
      { action: 'disconnect', network: 'stale' },
      { action: 'disconnect', network: 'extra' },
    ]);
    const stateWith = diffState(
      { connections: [], attachments: [...desired().attachments, 'newnet'], skipped: [] },
      { connections: [], dbNetworks: [], sidecarNetworks: ['default'] },
    );
    expect(stateWith.networkChanges).toStrictEqual([
      { action: 'connect', network: 'default' },
      { action: 'connect', network: 'newnet' },
    ]);
  });

  it('save_password drift alone does not cause an update', () => {
    const currentDbx = desired().connections.map((c) => ({ ...c, save_password: false }));
    const state = diffState(desired(), {
      connections: currentDbx,
      dbNetworks: desired().attachments,
      sidecarNetworks: SIDECAR,
    });
    expect(state.connectionChanges).toStrictEqual([]);
  });
});
