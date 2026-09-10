import type { DbxConnection } from './dbx-schema.js';

export interface NetworkEndpoint {
  readonly name: string;
  // Present only when the container is running and the daemon reports an
  // address for this network.
  readonly ip?: string;
}

// Flat view of dockerode's list + inspect output. The ticket-05 adapter owns
// the extraction; the pure core never sees dockerode types.
export interface ContainerSnapshot {
  readonly id: string;
  readonly name: string;
  readonly image: string;
  readonly running: boolean;
  // Docker's Config.Hostname — for stopped containers this is the only
  // reachable address form, and it is never inferred from the container name.
  readonly hostname: string | undefined;
  // Docker env entries come as KEY=VALUE strings; the snapshot carries them
  // pre-parsed.
  readonly env: Readonly<Record<string, string>>;
  readonly networks: readonly NetworkEndpoint[];
  readonly labels: Readonly<Record<string, string>>;
}

// Current dbx state as seen by the ticket-05 orchestrator: the saved
// connection list plus the network names dbx is currently attached to.
export interface DbxCurrentState {
  readonly connections: readonly DbxConnection[];
  // Sidecar's own networks; never disconnected, always part of the desired
  // attachment set.
  readonly sidecarNetworks: readonly string[];
  readonly dbNetworks: readonly string[];
}
