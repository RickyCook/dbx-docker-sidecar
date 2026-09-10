import axios from 'axios';
import type Docker from 'dockerode';

import { loadConfig, type SidecarConfig } from './config.js';
import { axiosAdapter, DbxClient } from './dbx.js';
import { dockerClient } from './docker.js';
import { createDockerAdapter } from './docker-adapter.js';
import { DockerEventSource } from './events.js';
import { childLogger } from './log.js';
import { Reconciler } from './reconcile.js';
import { sleep } from './sleep.js';

const config: SidecarConfig = loadConfig();

const log = childLogger('index');

log.info(
  {
    DBX_URL: config.DBX_URL,
    LABEL_PREFIX: config.LABEL_PREFIX,
    RESYNC_INTERVAL_MS: config.RESYNC_INTERVAL_MS,
    EVENT_DEBOUNCE_MS: config.EVENT_DEBOUNCE_MS,
  },
  'dbx-docker-sidecar starting',
);

const docker: Docker = dockerClient();
const adapter = createDockerAdapter(docker, config.LABEL_PREFIX, new URL(config.DBX_URL).hostname);
const dbx = new DbxClient(
  config.DBX_PASSWORD,
  axiosAdapter(axios.create({ baseURL: config.DBX_URL })),
);
const reconciler = new Reconciler(
  { docker: adapter, events: new DockerEventSource(docker), dbx },
  {
    labelPrefix: config.LABEL_PREFIX,
    resyncIntervalMs: config.RESYNC_INTERVAL_MS,
    eventDebounceMs: config.EVENT_DEBOUNCE_MS,
  },
);

const SHUTDOWN_GRACE_MS = 3_000;

async function main(): Promise<void> {
  await reconciler.start();
}

function shutdown(signal: NodeJS.Signals): void {
  log.info({ signal }, 'shutting down');
  // A hung daemon call must not hold the exit hostage: drain the reconciler
  // on a grace deadline, then leave no matter what.
  void Promise.race([reconciler.stop(), sleep(SHUTDOWN_GRACE_MS)]).finally(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// SAFETY: the process-level exit handler is the I/O boundary; any thrown
// value here is already fatal and only matters for its log fields.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
void main().catch((err: unknown) => {
  log.error({ err }, 'unexpected startup failure');
  process.exit(1);
});
