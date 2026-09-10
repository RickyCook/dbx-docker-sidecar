# dbx-docker-sidecar

A sidecar container that keeps [dbx](https://github.com/t8y2/dbx) in sync with labeled
Docker containers. Label anything with `com.thatpanda.show-in-dbx: true` and the sidecar:

1. attaches dbx to the container's Docker networks, and
2. registers a saved connection in dbx derived from the container's env vars and labels.

Remove the container and the sidecar cleans up both the connection and any networks dbx
no longer needs. The sidecar is stateless — on boot it reconciles from live Docker state,
so `docker compose up` (or restarting the sidecar) restores the exact same dbx state.

## Quickstart

```sh
cp .env.example .env      # set DBX_PASSWORD (required)
docker compose up -d      # dbx + sidecar
open http://localhost:4224
```

## How it fits together

```
 host ────────────────► :4224 dbx UI
                          │ data volume
                          ▼
┌──────────── docker network(s) ────────────┐
│  dbx ◄──API (login, connections, network) ─┐
│      ◄──network attachments─────────────  │
│                                           │
│  sidecar ──┴─ read-only docker.sock      │
│     │  watch events / list + inspect      │
│     ▼                                     │
│  labeled containers (postgres, mysql, …)  │
└───────────────────────────────────────────┘
```

The sidecar mounts `/var/run/docker.sock` read-only, computes a desired state
(connections + network attachments), diffs it against dbx, and applies the delta. dbx
uptime blips are invisible: after a dbx restart the sidecar re-logs-in, re-attaches, and
rebuilds the list.

## Label reference

Enable with the bare label; everything else is optional per-field override
(`<prefix>.<field>` on the same container). Defaults to the full prefix below;
change it via the `LABEL_PREFIX` env var.

| Label                          | Meaning                                            |
| ------------------------------ | -------------------------------------------------- |
| `com.thatpanda.show-in-dbx`    | `true`/`1` enables registration                     |
| `….db_type`                    | dbx db type (e.g. `postgres`, `mysql`, `redis`)     |
| `….name`                       | connection name (default: container name)           |
| `….host`                       | host override (default: see host strategy)          |
| `….port`                       | port (integer)                                      |
| `….username`                   | username                                            |
| `….password`                   | password (beware compose/plaintext label visibility) |
| `….database`                   | database name                                       |

## db-type detection

Cascade, first hit wins: **env vars** (`POSTGRES_*`, `MARIADB_*`, `MYSQL_*`) →
**image name substring** (`postgres`, `mariadb`, `mysql`) → **`.db_type` label**.
No hit ⇒ the labeled container is skipped with a warning and never blocks other
containers.

## Credential mapping

Defaults per official image docs; merge order **type defaults ← container env ← label
overrides**. MariaDB checks `MARIADB_*` before `MYSQL_*` fallbacks.

| db      | port  | username                            | password                                 | database                                     |
| ------- | ----- | ----------------------------------- | ---------------------------------------- | -------------------------------------------- |
| postgres| 5432  | `POSTGRES_USER` → `postgres`        | `POSTGRES_PASSWORD` → `""`               | `POSTGRES_DB` → user → `postgres`            |
| mysql   | 3306  | `MYSQL_ROOT_PASSWORD` ⇒ root; else `MYSQL_USER` | root pw or `MYSQL_PASSWORD`  | `MYSQL_DATABASE` or null                     |
| mariadb | 3306  | `MARIADB_ROOT_PASSWORD` ⇒ root; else `MARIADB_USER`(→`MYSQL_USER`) | same with `MARIADB_*` first | `MARIADB_DATABASE`→`MYSQL_DATABASE` or null |

If the merged result still lacks a port (true for any unknown engine) the container is
skipped unless something (label) supplies it. Unknown engines work **label-only**: e.g.
a labeled redis with `….db_type=redis`, `….port=6379`, plus any other override fields.

## Network policy

- dbx is attached to a **superset**: every network used by a labeled container, plus the
  sidecar's own networks (so the compose default network survives pruning — the
  sidecar→dbx API path never breaks).
- Networks **not** in the desired set and not sidecar-owned are disconnected — including
  networks you attached dbx to by hand. Network state is fully deterministic.
- One connection per container, chosen deterministically: first shared-with-sidecar
  network, else alphabetical.

## Host strategy

- **Running** container: its IP on the chosen shared network.
- **Stopped** container: `<Config.Hostname>.<network>` FQDN (Docker's DNS name), so a
  still-existing container is re-reachable by name when it restarts — the connection is
  never dropped just because it stopped.
- Destroyed container: connection removed entirely.

## Sidecar owns the list

The sidecar POSTs the **full connection list** it derives from Docker.
Connections created by hand in the dbx UI are wiped on the next sync — put them in
labels instead.

### Demo walkthrough

```sh
DBX_PASSWORD=… docker compose --profile demo up -d
```

Adds postgres, mysql, and mariadb with realistic env vars. After a few seconds the dbx UI
shows three saved connections with the right engine/creds; the demo `down` removes them
again. Default profile (no `demo`) starts only dbx + sidecar.

### Pinning / upgrading

dbx's HTTP API is **not a stable contract** — pin `DBX_IMAGE` in `.env`
(default `t8y2/dbx:0.6.9`) and treat sidecar/dbx version bumps as a pair.

## Troubleshooting

| Symptom                                | Check                                                                |
| -------------------------------------- | -------------------------------------------------------------------- |
| Connection never appears                | Label value is exactly `true` or `1`? An engine is detectable (env/image/`db_type`)? A port is supplied? Sidecar logs (`docker compose logs sidecar`) list each skip with a reason. |
| Connection host is a dotted id          | Container was stopped; it flips back to an IP when it runs again.     |
| `dbx container not found; network reconciliation deferred` | dbx is (re)starting / DBX_URL hostname mismatch — reconciles every few seconds until found. |
| `dbx login lockout, backing off`        | dbx lockout on bad credentials — check `DBX_PASSWORD` matches dbx's; the sidecar backs off instead of hammering. |
| UI manually added connections vanish    | Expected: sidecar owns the list (see above).                         |
| dbx unreachable warnings                 | dbx not up yet or wrong `DBX_URL`; sidecar retries within its budget. |

## Verification of this repo

`pnpm test`, `pnpm typecheck`, `pnpm lint`. Full spec lives in
[`spec.md`](spec.md); per-ticket build notes in [`tickets/`](tickets/).
The sidecar image is a bundle-only multi-stage build: one 3.3 MB `sidecar.cjs` on top of
the node alpine base (whole image ≈ 250 MB, the weight being the node runtime itself).
