import type Docker from 'dockerode';
import { z } from 'zod';

import { childLogger } from './log.js';
import type { ContainerSnapshot, NetworkEndpoint } from './snapshot.js';

const log = childLogger('docker-adapter');

// Inspect payloads are unvalidated wire data from the daemon, so the adapter
// validates the subset it reads with this schema instead of trusting
// dockerode's (enormous, assertion-prone) types. Unknown fields are stripped.
const InspectSchema = z.object({
  Id: z.string().min(1),
  Name: z.string(),
  Config: z.object({
    Image: z.string(),
    Hostname: z.string(),
    Env: z.array(z.string()).nullish(),
    Labels: z.record(z.string(), z.string()).nullish(),
  }),
  State: z.object({ Running: z.boolean() }),
  NetworkSettings: z.object({
    Networks: z
      .record(
        z.string(),
        z.object({
          IPAddress: z.string().nullish(),
          Aliases: z.array(z.string()).nullish(),
        }),
      )
      .nullish(),
  }),
});
export type InspectView = z.infer<typeof InspectSchema>;

// The one place daemon payloads cross into adapter logic. A shape-drifting
// inspect result drops the item (fail-open per container, like the core's
// skipped-container semantics) with a warning, never an exception.
// SAFETY: `raw` is exactly the opaque daemon JSON the InspectSchema above is
// written to validate; safeParse is that parse.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
function readInspect(raw: unknown, what: string): InspectView | undefined {
  if (raw === null || raw === undefined) {
    // A swallowed miss (e.g. 404 on the by-name lookup) is not a shape error.
    log.debug({ what }, 'no inspect payload; item skipped');
    return undefined;
  }
  const parsed = InspectSchema.safeParse(raw);
  if (!parsed.success) {
    log.warn(
      { what, issues: parsed.error.issues.length },
      'unexpected docker inspect shape; item skipped',
    );
    return undefined;
  }
  return parsed.data;
}

// Everything the orchestrator needs from the Docker daemon, typed at the
// level of the pure core's inputs (ContainerSnapshot) and outputs (network
// changes). Real dockerode calls live only in createDockerAdapter.
export interface DockerAdapter {
  // Labeled containers, running and stopped, with the inspect data the core
  // consumes (env parsed, networks named, IP attached when present).
  listLabeledContainers(): Promise<readonly ContainerSnapshot[]>;
  // The sidecar's own networks: never disconnected, always in the desired
  // attachment set.
  sidecarNetworks(): Promise<readonly string[]>;
  // Networks the dbx container is currently attached to.
  dbxNetworks(): Promise<readonly string[]>;
  connectDbx(network: string): Promise<void>;
  disconnectDbx(network: string): Promise<void>;
}

export function createDockerAdapter(
  docker: Docker,
  labelPrefix: string,
  dbxHostname: string,
): DockerAdapter {
  function parseEnv(
    entries: readonly string[] | null | undefined,
  ): Readonly<Record<string, string>> {
    const pairs = (entries ?? [])
      .filter((entry) => entry.indexOf('=') > 0)
      .map((entry) => {
        const index = entry.indexOf('=');
        return [entry.slice(0, index), entry.slice(index + 1)] as const;
      });
    return Object.fromEntries(pairs);
  }

  function endpoint(
    name: string,
    settings: { readonly IPAddress?: string | null | undefined },
  ): NetworkEndpoint {
    const ip = settings.IPAddress;
    return ip === undefined || ip === null || ip === '' ? { name } : { name, ip };
  }

  function toSnapshot(inspect: InspectView): ContainerSnapshot {
    const networks = Object.entries(inspect.NetworkSettings?.Networks ?? {}).map(
      ([name, settings]) => endpoint(name, settings ?? {}),
    );
    return {
      id: inspect.Id,
      // Inspect names the entry with a leading slash.
      name: inspect.Name.replace(/^\//, ''),
      image: inspect.Config.Image,
      running: inspect.State.Running,
      hostname: inspect.Config.Hostname === '' ? undefined : inspect.Config.Hostname,
      env: parseEnv(inspect.Config.Env),
      networks,
      labels: inspect.Config.Labels ?? {},
    };
  }

  async function inspectAll(ids: readonly string[]): Promise<readonly ContainerSnapshot[]> {
    const snapshots: ContainerSnapshot[] = [];
    for (const id of ids) {
      // A container destroyed between list and inspect is not an error; it is
      // simply gone, which destroy semantics express anyway.
      const inspect = readInspect(await docker.getContainer(id).inspect(), id);
      if (inspect !== undefined) {
        snapshots.push(toSnapshot(inspect));
      }
    }
    return snapshots;
  }

  // dbx is located from the hostname in DBX_URL, which is its name or a
  // network alias. Resolved per call so a restarted dbx container is picked
  // up on the next reconcile instead of pinning a stale id.
  async function locateDbx(): Promise<string | undefined> {
    const byName = readInspect(
      await docker
        .getContainer(dbxHostname)
        .inspect()
        .catch(() => undefined),
      `by-name:${dbxHostname}`,
    );
    if (byName !== undefined) {
      return byName.Id;
    }
    const listed = await docker.listContainers({ all: true });
    for (const entry of listed) {
      const inspect = readInspect(
        await docker
          .getContainer(entry.Id)
          .inspect()
          .catch(() => undefined),
        `list:${entry.Id}`,
      );
      const aliases = Object.values(inspect?.NetworkSettings?.Networks ?? {}).flatMap(
        (network) => network?.Aliases ?? [],
      );
      if (aliases.includes(dbxHostname)) {
        return inspect?.Id;
      }
    }
    return undefined;
  }

  return {
    listLabeledContainers: async () => {
      const listed = await docker.listContainers({
        all: true,
        // filters takes a plain object despite its string type in dockerode.
        filters: { label: [labelPrefix] },
      });
      log.debug({ count: listed.length }, 'listed labeled containers');
      return inspectAll(listed.map((entry) => entry.Id));
    },

    sidecarNetworks: async () => {
      // Inside the container, HOSTNAME is the container's id.
      const self = process.env.HOSTNAME;
      if (self === undefined || self === '') {
        log.debug('HOSTNAME unset; running outside docker, no sidecar networks');
        return [];
      }
      const inspect = readInspect(await docker.getContainer(self).inspect(), `self:${self}`);
      if (inspect === undefined) {
        return [];
      }
      return Object.keys(inspect.NetworkSettings?.Networks ?? {});
    },

    dbxNetworks: async () => {
      const dbxId = await locateDbx();
      if (dbxId === undefined) {
        log.warn({ dbxHostname }, 'dbx container not found; network reconciliation deferred');
        return [];
      }
      const inspect = readInspect(await docker.getContainer(dbxId).inspect(), `dbx:${dbxId}`);
      if (inspect === undefined) {
        return [];
      }
      return Object.keys(inspect.NetworkSettings?.Networks ?? {});
    },

    connectDbx: async (network) => {
      const dbxId = await locateDbx();
      if (dbxId === undefined) {
        throw new Error(`dbx container not found; cannot connect network ${network}`);
      }
      await docker.getNetwork(network).connect({ Container: dbxId });
    },

    disconnectDbx: async (network) => {
      const dbxId = await locateDbx();
      if (dbxId === undefined) {
        throw new Error(`dbx container not found; cannot disconnect network ${network}`);
      }
      await docker.getNetwork(network).disconnect({ Container: dbxId, Force: false });
    },
  };
}
