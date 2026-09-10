# dbx-docker-sidecar

A sidecar container that keeps [dbx](https://github.com/t8y2/dbx) in sync with labeled
Docker containers. Label anything with `com.thatpanda.show-in-dbx: true` and the sidecar:

1. attaches dbx to the container's Docker networks, and
2. registers a saved connection in dbx derived from the container's env vars and labels.

Remove the container and the sidecar cleans up both the connection and any networks dbx
no longer needs. The sidecar is stateless — on boot it reconciles from live Docker state,
so `docker compose up` (or restarting the sidecar) restores the exact same dbx state.

## Slop honesty

This is _entirely_ AI slop code that was built in the background while I did other
things. Don't rely on it, but hey it exists where otherwise it wouldn't and it's damn
helpful for local dev work across multiple projects.

## Quickstart

```sh
cp .env.example .env      # set DBX_PASSWORD (required)
docker compose up -d      # dbx + sidecar (builds the sidecar image locally)
open http://localhost:4224
```

No repo clone? Copy the `dbx` and `sidecar` services out of `compose.yml` into your
project's compose file, and set `DBX_SIDECAR_IMAGE` (or replace the sidecar's
`build:` with `image: ghcr.io/rickycook/dbx-docker-sidecar:…`) to skip any local build.

### Demo walkthrough

```sh
DBX_PASSWORD=… docker compose --profile demo up -d
```

Adds postgres, mysql, and mariadb with realistic env vars. After a few seconds the dbx UI
shows three saved connections with the right engine/creds; the demo `down` removes them
again. Default profile (no `demo`) starts only dbx + sidecar.

### Pinning / upgrading

dbx's HTTP API is **not a stable contract** — pin `DBX_IMAGE` in `.env`
(default `t8y2/dbx:0.6.9`) and `DBX_SIDECAR_IMAGE` to a semver sidecar image
(e.g. `ghcr.io/rickycook/dbx-docker-sidecar:v0.1.0`, publishes on release tags).
Treat sidecar/dbx version bumps as a pair.

Released images are immutable-ish: publish derives from a semver tag, tag rules
protect `v*` from force-pushes (Settings → Tags), and the release workflow
refuses to republish a `ghcr.io` tag that already exists.

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

## Managed vs unmanaged connections

The sidecar marks every connection it creates with a note: **“managed by
dbx-docker-sidecar — do not remove”**. That note is the ownership marker — a
connection is the sidecar's **iff its note matches exactly**.

- **Managed** connections: derived from labeled containers. Updated on any field
  change, removed when the container is destroyed.
- **Unmanaged** connections (anything hand-created in the dbx UI, e.g. a cloud
  database): passed through every save **verbatim** — never edited, never
  removed.
- A hand-created connection whose id happens to collide with a sidecar-derived
  id (same container name, different config) is never overridden; the sidecar
  logs an error and stays out of its way. Connections left by pre-marker
  sidecar versions are adopted automatically when their fields already match.

Networks remain full-control: dbx is disconnected from attachments outside the
desired superset, including manual ones (see Network policy).

## Troubleshooting

| Symptom                                | Check                                                                |
| -------------------------------------- | -------------------------------------------------------------------- |
| Connection never appears                | Label value is exactly `true` or `1`? An engine is detectable (env/image/`db_type`)? A port is supplied? Sidecar logs (`docker compose logs sidecar`) list each skip with a reason. |
| Connection host is a dotted id          | Container was stopped; it flips back to an IP when it runs again.     |
| `dbx container not found; network reconciliation deferred` | dbx is (re)starting / DBX_URL hostname mismatch — reconciles every few seconds until found. |
| `dbx login lockout, backing off`        | dbx lockout on bad credentials — check `DBX_PASSWORD` matches dbx's; the sidecar backs off instead of hammering. |
| Connection removed though hand-added   | Was its note edited (marker no longer exact)? Unmarked connections are never removed. Check sidecar logs for the collision error. |
| dbx unreachable warnings                 | dbx not up yet or wrong `DBX_URL`; sidecar retries within its budget. |

## Verification of this repo

`pnpm test`, `pnpm typecheck`, `pnpm lint`. Full spec and per-ticket build history live in
GitHub Issues (#1 spec, #2–#8 tickets).
The sidecar image is a bundle-only multi-stage build: one 3.3 MB `sidecar.cjs` on top of
the node alpine base (whole image ≈ 250 MB, the weight being the node runtime itself).
