import type { DbxClient } from './dbx.js';
import type { DockerAdapter } from './docker-adapter.js';
import type { DockerEvent, EventSource } from './events.js';
import { childLogger } from './log.js';
import { computeDesired, diffState } from './reconcile-core.js';
import { sleep } from './sleep.js';

const log = childLogger('reconcile');

const BOOT_RETRY_DELAY_MS = 3_000;

export interface ReconcilerOptions {
  readonly labelPrefix: string;
  readonly resyncIntervalMs: number;
  readonly eventDebounceMs: number;
}

export interface ReconcilerDeps {
  readonly docker: DockerAdapter;
  readonly events: EventSource;
  readonly dbx: DbxClient;
}

// The reconcile loop: boot reconcile → debounced event reconciles → periodic
// resync. Errors in one reconcile are logged and retried by the next cycle;
// they never stop the loop.
export class Reconciler {
  readonly #deps: ReconcilerDeps;
  readonly #options: ReconcilerOptions;
  #resyncTimer: NodeJS.Timeout | undefined;
  #debounceTimer: NodeJS.Timeout | undefined;
  #inFlight: Promise<void> = Promise.resolve();

  constructor(deps: ReconcilerDeps, options: ReconcilerOptions) {
    this.#deps = deps;
    this.#options = options;
  }

  // Startup waits/retries until one full reconcile succeeds; dbx being down
  // is a normal early state, not a crash.
  async boot(): Promise<void> {
    for (;;) {
      try {
        await this.reconcile();
        log.info('boot reconcile complete');
        return;
      } catch (error: unknown) {
        log.warn({ err: error }, 'boot reconcile failed; waiting for dbx/docker to come up');
        await sleep(BOOT_RETRY_DELAY_MS);
      }
    }
  }

  // One full pass: list → diff → apply. Throws so callers (boot/cron) can
  // distinguish success from "retry later"; network-apply errors inside a
  // pass are logged individually and never abort the pass.
  async reconcile(): Promise<void> {
    const [sidecar, current, snapshots] = await Promise.all([
      this.#deps.docker.sidecarNetworks(),
      this.#deps.dbx.listConnections(),
      this.#deps.docker.listLabeledContainers(),
    ]);
    const dbNetworks = await this.#deps.docker.dbxNetworks();
    const desired = computeDesired(snapshots, {
      labelPrefix: this.#options.labelPrefix,
      sidecarNetworks: sidecar,
    });
    const diff = diffState(desired, {
      connections: current,
      dbNetworks,
      sidecarNetworks: sidecar,
    });

    if (diff.connectionChanges.length > 0) {
      // Dbx save semantics are full-list replace; the desired list IS the
      // payload, so save it when the diff is non-empty.
      for (const change of diff.connectionChanges) {
        if (change.action === 'remove') {
          log.info({ id: change.id }, 'connection removed');
        } else {
          log.info({ action: change.action, name: change.connection.name }, 'connection change');
        }
      }
      await this.#deps.dbx.saveConnections(desired.connections);
    }

    for (const change of diff.networkChanges) {
      try {
        if (change.action === 'connect') {
          log.info({ network: change.network }, 'connecting dbx to network');
          await this.#deps.docker.connectDbx(change.network);
        } else {
          log.info({ network: change.network }, 'disconnecting dbx from network');
          await this.#deps.docker.disconnectDbx(change.network);
        }
      } catch (error: unknown) {
        log.warn(
          { err: error, network: change.network },
          'network apply failed; retrying next cycle',
        );
      }
    }

    if (desired.skipped.length > 0) {
      log.debug({ skipped: desired.skipped }, 'labeled containers skipped');
    }
  }

  // Runs boot to completion, then starts the periodic resync and the event
  // stream with debounced reconciles.
  async start(): Promise<void> {
    await this.boot();
    this.#resyncTimer = setInterval(() => {
      void this.#cycle('resync');
    }, this.#options.resyncIntervalMs);
    this.#deps.events.start((event) => this.#scheduleDebounced(event));
  }

  #scheduleDebounced(event: DockerEvent): void {
    log.debug({ event }, 'docker event; reconciling after debounce');
    clearTimeout(this.#debounceTimer);
    this.#debounceTimer = setTimeout(() => {
      void this.#cycle('event');
    }, this.#options.eventDebounceMs);
  }

  // Every reconcile runs through this so stop() can await the in-flight work
  // instead of tearing down mid-apply.
  async #cycle(source: 'event' | 'resync'): Promise<void> {
    const run = this.#inFlight.then(async () => {
      try {
        await this.reconcile();
        log.debug({ source }, 'reconcile ok');
      } catch (error: unknown) {
        log.warn({ err: error, source }, 'reconcile failed; retrying next cycle');
      }
    });
    this.#inFlight = run;
    await run;
  }

  // SIGTERM path: close the event stream, clear timers, wait for any
  // in-flight reconcile so nothing is half-applied.
  async stop(): Promise<void> {
    clearInterval(this.#resyncTimer);
    clearTimeout(this.#debounceTimer);
    this.#resyncTimer = undefined;
    this.#debounceTimer = undefined;
    await this.#deps.events.stop();
    await this.#inFlight;
    log.info('reconciler stopped');
  }
}
