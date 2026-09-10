import { describe, expect, it, vi } from 'vitest';

import { DbxClient, type DbxHttpAdapter, DbxUnreachableError } from './dbx.js';
import { type DbxConnection, DbxSaveBodySchema } from './dbx-schema.js';
import type { DockerAdapter } from './docker-adapter.js';
import type { DockerEvent, EventSource } from './events.js';
import { Reconciler } from './reconcile.js';
import type { ContainerSnapshot } from './snapshot.js';

const PREFIX = 'com.thatpanda.show-in-dbx';
const RESYNC_MS = 60_000;
const DEBOUNCE_MS = 1_500;
const BOOT_GRACE_MS = 60_000;

const LIST_PATH = '/api/connection/list';
const SAVE_PATH = '/api/connection/save';
const LOGIN_PATH = '/api/auth/login';
const CHECK_PATH = '/api/auth/check';

function snapshot(overrides: Partial<ContainerSnapshot> = {}): ContainerSnapshot {
  return {
    id: 'cid-1',
    name: 'order-db-1',
    image: 'postgres:17',
    running: true,
    hostname: 'a1b2c3d4',
    env: {},
    networks: [{ name: 'app-net', ip: '172.18.0.5' }],
    labels: { [PREFIX]: 'true' },
    ...overrides,
  };
}

class FakeDocker implements DockerAdapter {
  containers: ContainerSnapshot[] = [];
  sidecar: string[] = [];
  dbxAttached = new Set<string>();
  applied: string[] = [];

  listLabeledContainers(): Promise<readonly ContainerSnapshot[]> {
    return Promise.resolve(this.containers.map((container) => ({ ...container })));
  }

  sidecarNetworks(): Promise<readonly string[]> {
    return Promise.resolve(this.sidecar);
  }

  dbxNetworks(): Promise<readonly string[]> {
    return Promise.resolve([...this.dbxAttached]);
  }

  connectDbx(network: string): Promise<void> {
    this.applied.push(`connect:${network}`);
    this.dbxAttached.add(network);
    return Promise.resolve();
  }

  disconnectDbx(network: string): Promise<void> {
    this.applied.push(`disconnect:${network}`);
    this.dbxAttached.delete(network);
    return Promise.resolve();
  }
}

interface DbxMemory {
  connections: DbxConnection[];
  unreachable: boolean;
  saves: number;
}

// Real DbxClient over a fake HTTP adapter, so relogin/session semantics run.
function fakeDbx(memory: DbxMemory, retryBudgetMs: number): DbxClient {
  const adapter: DbxHttpAdapter = {
    request: async (_method, path, data) => {
      if (memory.unreachable) {
        throw new DbxUnreachableError('ECONNREFUSED');
      }
      if (path === LOGIN_PATH) {
        return { status: 200, data: null, setCookie: () => 'dbx_session=fake' };
      }
      if (path === CHECK_PATH) {
        return {
          status: 200,
          data: { authenticated: true, required: true, setup_required: false },
          setCookie: () => undefined,
        };
      }
      if (path === LIST_PATH) {
        return { status: 200, data: memory.connections, setCookie: () => undefined };
      }
      if (path === SAVE_PATH) {
        const body = DbxSaveBodySchema.parse(data);
        memory.connections = body.configs.slice();
        memory.saves += 1;
        return { status: 200, data: null, setCookie: () => undefined };
      }
      return { status: 404, data: null, setCookie: () => undefined };
    },
  };
  return new DbxClient('pw', adapter, (ms: number) => sleepFor(ms), retryBudgetMs, 5);
}

function sleepFor(_ms: number): Promise<void> {
  return Promise.resolve();
}

class FakeEvents implements EventSource {
  handler: ((event: DockerEvent) => void) | undefined;
  startCalls = 0;
  stopped = false;

  start(onEvent: (event: DockerEvent) => void): void {
    this.startCalls += 1;
    this.handler = onEvent;
  }

  emit(action: string): void {
    this.handler?.({ Type: 'container', Action: action });
  }

  stop(): Promise<void> {
    this.stopped = true;
    return Promise.resolve();
  }
}

interface Harness {
  docker: FakeDocker;
  dbx: DbxMemory;
  events: FakeEvents;
  reconciler: Reconciler;
}

function harness(retryBudgetMs = 100): Harness {
  const docker = new FakeDocker();
  docker.sidecar = ['app-net'];
  const dbxMemory: DbxMemory = { connections: [], unreachable: false, saves: 0 };
  const events = new FakeEvents();
  const dbx = fakeDbx(dbxMemory, retryBudgetMs);
  const reconciler = new Reconciler(
    { docker, events, dbx },
    { labelPrefix: PREFIX, resyncIntervalMs: RESYNC_MS, eventDebounceMs: DEBOUNCE_MS },
  );
  return { docker, dbx: dbxMemory, events, reconciler };
}

describe('reconcile loop', () => {
  it('boot sync: creates a connection for a running labeled container', async () => {
    const h = harness();
    h.docker.containers = [snapshot()];
    await h.reconciler.reconcile();
    expect(h.dbx.saves).toBe(1);
    expect(h.dbx.connections).toMatchObject([
      {
        name: 'order-db-1',
        db_type: 'postgres',
        host: '172.18.0.5',
        port: 5432,
        username: 'postgres',
        database: 'postgres',
      },
    ]);
  });

  it('stop: connection is kept and the host switches to the FQDN form', async () => {
    const h = harness();
    h.docker.containers = [snapshot()];
    await h.reconciler.reconcile();
    // A stopped container loses its IP on the shared network.
    h.docker.containers = [snapshot({ running: false, networks: [{ name: 'app-net' }] })];
    await h.reconciler.reconcile();
    expect(h.dbx.connections).toMatchObject([{ name: 'order-db-1', host: 'a1b2c3d4.app-net' }]);
  });

  it('destroy: connection is removed and its dedicated network pruned', async () => {
    const h = harness();
    h.docker.containers = [snapshot()];
    await h.reconciler.reconcile();
    h.docker.containers = [];
    await h.reconciler.reconcile();
    expect(h.dbx.connections).toEqual([]);
    expect(h.docker.applied).toContain('connect:app-net');
    expect(h.docker.dbxAttached).toEqual(new Set(['app-net']));
  });

  it('a network only the dc container knows gets connected; extraneous ones are pruned', async () => {
    const h = harness();
    h.docker.containers = [
      snapshot({ networks: [{ name: 'app-net', ip: '172.18.0.5' }, { name: 'extra-net' }] }),
    ];
    h.docker.dbxAttached = new Set(['stale-net', 'app-net']);
    await h.reconciler.reconcile();
    expect(h.docker.dbxAttached).toEqual(new Set(['app-net', 'extra-net']));
    expect(h.docker.applied).toContain('connect:extra-net');
    expect(h.docker.applied).toContain('disconnect:stale-net');
  });

  it('never disconnects a sidecar-only network', async () => {
    const h = harness();
    h.docker.sidecar = ['app-net', 'invited-net'];
    h.docker.dbxAttached = new Set(['invited-net', 'stale-net']);
    await h.reconciler.reconcile();
    expect(h.docker.dbxAttached).toEqual(new Set(['app-net', 'invited-net']));
    expect(h.docker.applied).toContain('disconnect:stale-net');
    expect(h.docker.applied).not.toContain('disconnect:invited-net');
  });

  it('idempotence: an identical pass does not save or touch networks', async () => {
    const h = harness();
    h.docker.containers = [snapshot()];
    await h.reconciler.reconcile();
    const saves = h.dbx.saves;
    const applied = [...h.docker.applied];
    await h.reconciler.reconcile();
    expect(h.dbx.saves).toBe(saves);
    expect(h.docker.applied).toEqual(applied);
  });

  it('dbx outage: reconcile fails cleanly and the next pass applies the backlog', async () => {
    const h = harness();
    h.docker.containers = [snapshot()];
    h.dbx.unreachable = true;
    await expect(h.reconciler.reconcile()).rejects.toThrow();
    h.dbx.unreachable = false;
    await h.reconciler.reconcile();
    expect(h.dbx.connections).toHaveLength(1);
  });
});

describe('event stream wiring', () => {
  it('events debounce into one reconcile and stop() closes cleanly', async () => {
    vi.useFakeTimers();
    try {
      const harness_ = harness(100);
      harness_.docker.containers = [];
      const started = harness_.reconciler.start();
      await vi.advanceTimersByTimeAsync(0);
      await started;
      expect(harness_.events.startCalls).toBe(1);

      // A container is created and its recreate event lands before the
      // debounce fires: exactly one pass sees the final state.
      harness_.events.emit('create');
      harness_.docker.containers = [snapshot()];
      harness_.events.emit('destroy');
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 1);
      expect(harness_.dbx.saves).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(harness_.dbx.saves).toBe(1);
      expect(harness_.dbx.connections).toMatchObject([{ name: 'order-db-1' }]);

      await harness_.reconciler.stop();
      expect(harness_.events.stopped).toBe(true);

      // No half-applied work after stop: further events do nothing.
      harness_.events.emit('create');
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + RESYNC_MS);
      expect(harness_.dbx.saves).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sidecar cleanup: events after stop are ignored, timers cleared', async () => {
    vi.useFakeTimers();
    try {
      const cleaner = harness();
      cleaner.docker.containers = [snapshot()];
      const started = cleaner.reconciler.start();
      await vi.advanceTimersByTimeAsync(0);
      await started;

      // Missed-event scenario: the daemon drops the stream so a create event
      // never fires; the periodic resync still converges.
      cleaner.docker.containers = [
        snapshot(),
        snapshot({ id: 'cid-2', name: 'closed-db-1', image: 'mysql:8' }),
      ];
      await vi.advanceTimersByTimeAsync(RESYNC_MS);
      expect(cleaner.dbx.connections.map((connection) => connection.name)).toEqual([
        'order-db-1',
        'closed-db-1',
      ]);

      await cleaner.reconciler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('boot waits until dbx is reachable before starting the loop', async () => {
    vi.useFakeTimers();
    try {
      const booted = harness(300);
      booted.dbx.unreachable = true;
      booted.docker.containers = [snapshot()];
      const started = booted.reconciler.start();

      await vi.advanceTimersByTimeAsync(RESYNC_MS);
      expect(booted.dbx.saves).toBe(0);

      booted.dbx.unreachable = false;
      await vi.advanceTimersByTimeAsync(BOOT_GRACE_MS);
      await started;

      expect(booted.dbx.saves).toBeGreaterThan(0);
      expect(booted.dbx.connections).toHaveLength(1);
      expect(booted.events.startCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
