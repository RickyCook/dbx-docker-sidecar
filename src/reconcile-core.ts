import { createHash } from 'node:crypto';

import type { DbxConnection } from './dbx-schema.js';
import { detectDbType, mergedConfig, parseLabels } from './detection.js';
import type { ContainerSnapshot } from './snapshot.js';

export interface SkippedContainer {
  readonly name: string;
  readonly reason: string;
}

type ConnectionBuild =
  | { readonly ok: true; readonly connection: DbxConnection }
  | { readonly ok: false; readonly reason: string };

// Ownership marker stored in the connection's note field (a first-class
// dbx field; anything unknown to dbx is silently dropped on save — see
// docs/agents/dbx.md). Exact match, never substring: a note that merely
// mentions the marker is not ours.
export const MANAGED_NOTE = 'managed by dbx-docker-sidecar — do not remove';

export function isManaged(connection: DbxConnection): boolean {
  return connection.note === MANAGED_NOTE;
}

export function connectionId(name: string): string {
  return createHash('sha1').update(name).digest('hex').slice(0, 16);
}

// Chosen network is deterministic: the first network the sidecar shares,
// otherwise alphabetical.
export function chooseNetwork(
  networks: readonly { readonly name: string }[],
  sidecarNetworks: readonly string[],
): string | undefined {
  const sorted = [...networks]
    .map((network) => network.name)
    .sort((a, b) => {
      const aShared = sidecarNetworks.includes(a) ? 0 : 1;
      const bShared = sidecarNetworks.includes(b) ? 0 : 1;
      return aShared - bShared || a.localeCompare(b);
    });
  return sorted[0];
}

// Generic merge order: type defaults ← env-derived ← label overrides, then
// zod checks that everything a dbx connection requires is present.
function buildConnection(
  snapshot: ContainerSnapshot,
  labelPrefix: string,
  sidecarNetworks: readonly string[],
): ConnectionBuild {
  const { enabled, overrides } = parseLabels(snapshot.labels, labelPrefix);
  if (!enabled) {
    return { ok: false, reason: 'label not set to an enabling value (true/1)' };
  }
  const detection = detectDbType(snapshot.image, snapshot.env, overrides.dbType);
  if (!detection.ok) {
    return { ok: false, reason: detection.reason };
  }
  const network = chooseNetwork(snapshot.networks, sidecarNetworks);
  if (network === undefined) {
    return { ok: false, reason: 'container has no Docker network' };
  }
  const merged = mergedConfig(detection.dbType, snapshot.env, overrides);
  if (!merged.ok) {
    return { ok: false, reason: `${merged.reason}` };
  }
  const { config } = merged;
  const connection: DbxConnection = {
    id: connectionId(snapshot.name),
    name: overrides.name ?? snapshot.name,
    db_type: config.dbType,
    host: overrides.host ?? firstIp(snapshot, network) ?? `${hostnameOf(snapshot)}.${network}`,
    port: config.port,
    username: config.username,
    password: config.password,
    database: config.database,
    save_password: true,
    note: MANAGED_NOTE,
  };
  return { ok: true, connection };
}

function hostnameOf(snapshot: ContainerSnapshot): string {
  return snapshot.hostname === undefined || snapshot.hostname === ''
    ? snapshot.name
    : snapshot.hostname;
}

function firstIp(snapshot: ContainerSnapshot, network: string): string | undefined {
  return snapshot.networks.find((entry) => entry.name === network)?.ip;
}

export interface DesiredState {
  readonly connections: readonly DbxConnection[];
  readonly attachments: readonly string[];
  readonly skipped: readonly SkippedContainer[];
}

// Desired attachment set always includes the sidecar's own networks, so the
// compose default network survives pruning (spec decision: deterministic,
// full-control attachment).
export function computeDesired(
  snapshots: readonly ContainerSnapshot[],
  options: { readonly labelPrefix: string; readonly sidecarNetworks: readonly string[] },
): DesiredState {
  const connections: DbxConnection[] = [];
  const skipped: SkippedContainer[] = [];
  const attachments = new Set(options.sidecarNetworks);
  for (const snapshot of snapshots) {
    const build = buildConnection(snapshot, options.labelPrefix, options.sidecarNetworks);
    if (build.ok) {
      connections.push(build.connection);
    } else {
      skipped.push({ name: snapshot.name, reason: build.reason });
    }
    for (const network of snapshot.networks) {
      attachments.add(network.name);
    }
  }
  return { connections, attachments: [...attachments], skipped };
}

export type ConnectionChange =
  | { readonly action: 'add'; readonly connection: DbxConnection }
  | { readonly action: 'update'; readonly connection: DbxConnection }
  // Flows only from destroy semantics: the container is gone from the
  // snapshot, so its id is present-in-dbx but absent-in-desired.
  | { readonly action: 'remove'; readonly id: string };

// A dbx connection whose id collides with a derived one but which carries no
// marker: someone else's config, never to be overridden or removed.
export interface ConnectionConflict {
  readonly id: string;
  readonly name: string;
}

export type NetworkChange =
  | { readonly action: 'connect'; readonly network: string }
  | { readonly action: 'disconnect'; readonly network: string };

// Comparable fields exclude save_password: dbx owns that flag's echo and it
// never carries reconcile-relevant state.
function sameConnection(a: DbxConnection, b: DbxConnection): boolean {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.db_type === b.db_type &&
    a.host === b.host &&
    a.port === b.port &&
    a.username === b.username &&
    a.password === b.password &&
    a.database === b.database
  );
}

export interface DesiredStateDiff {
  readonly connectionChanges: readonly ConnectionChange[];
  readonly conflicts: readonly ConnectionConflict[];
  readonly networkChanges: readonly NetworkChange[];
}

// Classification per desired connection id (add / update / adopt / conflict)
// and per current connection (remove when managed + absent-from-desired).
export function diffState(
  desired: DesiredState,
  current: {
    readonly connections: readonly DbxConnection[];
    readonly dbNetworks: readonly string[];
    readonly sidecarNetworks: readonly string[];
  },
): DesiredStateDiff {
  const desiredById = new Map(desired.connections.map((connection) => [connection.id, connection]));
  const currentById = new Map(current.connections.map((connection) => [connection.id, connection]));

  const connectionChanges: ConnectionChange[] = [];
  const conflicts: ConnectionConflict[] = [];
  for (const [id, connection] of desiredById) {
    const existing = currentById.get(id);
    if (existing === undefined) {
      connectionChanges.push({ action: 'add', connection });
    } else if (!isManaged(existing)) {
      // Not ours. Claimed only when the fields already agree byte for byte —
      // the marker is the only thing the adopt-below save adds. Anything
      // else is a conflict: someone else's config stays untouched.
      if (!sameConnection(existing, connection)) {
        conflicts.push({ id, name: existing.name });
      } else {
        connectionChanges.push({ action: 'update', connection: { ...existing, ...connection } });
      }
    } else if (!sameConnection(existing, connection)) {
      connectionChanges.push({ action: 'update', connection: { ...existing, ...connection } });
    }
  }
  for (const [id, existing] of currentById) {
    if (!desiredById.has(id) && isManaged(existing)) {
      connectionChanges.push({ action: 'remove', id });
    }
  }

  const networkChanges: NetworkChange[] = [];
  const desiredNetworks = new Set(desired.attachments);
  for (const network of desiredNetworks) {
    if (!current.dbNetworks.includes(network)) {
      networkChanges.push({ action: 'connect', network });
    }
  }
  for (const network of current.dbNetworks) {
    if (!desiredNetworks.has(network) && !current.sidecarNetworks.includes(network)) {
      networkChanges.push({ action: 'disconnect', network });
    }
  }
  return { connectionChanges, conflicts, networkChanges };
}

// The save payload replaces dbx's entire list, so it must carry everything:
// desired connections (merged over their current managed copy so dbx-side
// fields like color or ssl survive a save), plus every unmanaged connection
// verbatim. Conflicted ids are excluded wholesale — the manual entry wins
// and the derived connection is not written.
export function buildSavePayload(
  desired: DesiredState,
  conflicts: readonly ConnectionConflict[],
  current: { readonly connections: readonly DbxConnection[] },
): DbxConnection[] {
  const conflictedIds = new Set(conflicts.map((conflict) => conflict.id));
  const currentById = new Map(current.connections.map((connection) => [connection.id, connection]));
  const payload: DbxConnection[] = [];
  for (const connection of desired.connections) {
    if (conflictedIds.has(connection.id)) {
      continue;
    }
    const existing = currentById.get(connection.id);
    payload.push(existing !== undefined ? { ...existing, ...connection } : connection);
  }
  for (const connection of currentById.values()) {
    if (!isManaged(connection)) {
      payload.push(connection);
    }
  }
  return payload;
}
