# dbx-docker-sidecar

A single-purpose sidecar that mirrors labeled Docker containers into dbx's connection list and network attachments. Docker is the source of truth; dbx is the projection.

## Language

### Inputs

**dbx**:
The database-connection manager this sidecar serves. Reached over its Web API with a password session. _Avoid_: the manager, the target service

**Labeled container**:
A container carrying the `com.thatpanda.show-in-dbx` label (or the configured `LABEL_PREFIX`). Only labeled containers participate in reconciliation. _Avoid_: watched container, managed container

**Enabling label value**:
The label value `true` or `1`. Anything else means the container is invisible to the sidecar. _Avoid_: truthy

**Label override**:
A `<prefix>.<field>` label that replaces a single merged connection field. _Avoid_: sub-label, field label

**Container snapshot**:
The per-container picture reconciliation reads: name, image, hostname, running flag, raw env, and per-network IP. Cast from validated docker inspect payloads. _Avoid_: inspect result

**Skipped container**:
A labeled container that yields no connection, paired with a reason (no engine detected, no port, no network). Reported as data, not log noise. _Avoid_: failed container

### Detection and credentials

**Detection cascade**:
The fixed order db type is inferred: env vars → image-name substring → `db_type` label → skip. First hit wins. _Avoid_: fingerprinting

**Merged config**:
The connection fields assembled as type Defaults ← container env ← label overrides, then validated. _Avoid_: resolved config

**Engine defaults**:
The port/username/password/database assumptions stock official images imply (e.g. postgres `5432`, mysql `3306` root). _Avoid_: DEFAULT_PORTS, built-in config

### Desired state

**Connection**:
One dbx saved entry, at most one per container. Owed a deterministic id so recreation updates in place. _Avoid_: connection config, credential entry

**Connection id**:
16 hex chars of SHA-1 of the container name. Stable across restarts and IP changes. _Avoid_: uuid

**Desired state**:
The full connection list plus network attachment set computed from current Docker reality. _Avoid_: plan, target state

**Change plan**:
The explicit delta (add/update/remove connections; connect/disconnect networks) between desired and current. _Avoid_: diff output

### Ownership and networks

**Owned lists**:
On every apply the sidecar replaces dbx's entire connection list; connections created in the dbx UI are wiped at the next sync. dbx never holds state the sidecar would preserve.

**Attachment superset**:
The attachment set that is always a superset of any labeled container's networks plus the sidecar's own networks — so api connectivity survives pruning. _Avoid_: network union

**Default network**:
The compose-project network the sidecar and dbx share. Never disconnected, guaranteeing the sidecar→dbx API path.

**Network pruning**:
Disconnecting dbx from any attachment outside the desired superset, including manual attachments. State is fully deterministic; docs call this full-control attachment.

### Reconciliation

**Boot reconcile**:
The pass on sidecar startup that reconciles from live Docker state, making the sidecar stateless and restart-safe with identical end-state. _Avoid_: initial sync

**Docker event**:
A container or network event from the daemon's event stream that triggers a debounced reconcile. Debounce (~1.5 s) coalesces bursts into one pass. _Avoid_: event trigger

**Periodic resync**:
The 60-second full reconcile that catches events lost to stream drops. _Avoid_: tick, sweep

**Host strategy**:
How a connection's host is chosen: running containers resolve to an IP on the chosen shared network; stopped containers keep their connection with an FQDN host (`<hostname>.<network>`); destroyed containers lose their connection. _Avoid_: IP/FQDN fallback

**Stopped container**:
An existing, non-running container. Its connection is kept (FQDN host), never removed.

### dbx API

**Full-list save**:
The only write to dbx connections: POST the complete list; dbx deletes everything absent. _Avoid_: upsert, partial save

**Session cookie**:
The `dbx_session` cookie from password login, reused until expiry (one silent re-login).

**Lockout**:
dbx's 429 response to repeated login failures; met with a backoff, never hammering. _Avoid_: rate limit, ban
