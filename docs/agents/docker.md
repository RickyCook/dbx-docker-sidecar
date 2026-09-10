# Docker / docker-compose integration

What we learned driving the Docker daemon (dockerode) and compose from this project. Domain vocabulary (labeled container, snapshot, attachment superset, …) is defined in `CONTEXT.md`; this file holds tool-level facts only.

## dockerode

- **Dockerode's own types are enormous and assertion-prone.** Never treat inspect payloads as typed truth: zod-validate the subset you read (see `InspectSchema` in `src/docker-adapter.ts`) and fail open per-item on shape drift.
- Inspect is full of `null`-where-type-says-string fields (`Aliases: null`, missing `Env`/`Labels`). `.nullish()` everywhere.
- **A by-name lookup that 404s returns no payload, not an error** — `getContainer(name).inspect()` resolves with `undefined`-equivalent. Distinguish this (logged at debug, normal during races/recreates) from real payload drift (warn). `readInspect` in `src/docker-adapter.ts` is the single boundary.
- Event streams (`GET /events`) arrive as **newline-delimited JSON over a plain stream** — dockerode hands the response through raw. Chunk-buffer by line, drop unparseable lines with a warning, never crash the loop; the stream dies periodically and reconnecting on `close`/`error` after 1 s is expected background behavior (see `src/events.ts`). Events are lossy — always pair them with a periodic full resync and boot reconcile.
- Filters syntax: `{ filters: { type: ['container', 'network'] } }`.

## Compose-managed container naming

- Compose names containers `<project>-<service>-<index>` (e.g. `dbx-docker-sidecar-dbx-1`). **Service names like `dbx` are network aliases, not container names** — `inspect('dbx')` 404s against a compose-managed container. Resolve dbx from the hostname in `DBX_URL` by checking names/aliases on shared networks instead (see ticket 06's deviation note).
- `docker compose run -d` creates one-off containers with surprising naming/lifecycle — for test containers use plain `docker run` with explicit network + labels.

## compose quirks

- compose v5.3.1: `docker compose -p proj --profile demo up` errors (`unknown flag`); run `docker compose --profile demo up` first, then `-p proj ...` works. Position matters.
- Socket permission: on Docker Desktop the socket is **root-group** owned — build the image with a `DOCKER_GID` build arg and `addgroup -g "$DOCKER_GID" docker` (see Dockerfile; `DOCKER_GID=0` leaves the node user in the root group).

## Labels are the right extension point

Container labels (project namespace like `com.thatpanda.show-in-dbx.*`) are visible in inspect even for stopped containers — that's what makes stop/destroy semantics clean. Env vars are also inspect-visible, so credential env (`POSTGRES_*` etc.) works as a data source without mounting anything.
