# dbx integration

What we learned wiring this sidecar to dbx's Web API. Domain vocabulary (connection, full-list save, lockout, ...) is defined in `CONTEXT.md`; this file holds tool-level facts only. Facts are pinned to dbx `0.6.9` (`t8y2/dbx`) — see the repo README for the pin-upgrade policy.

## The API is not a stable contract

- dbx's HTTP API is internal. **Pin the image** (`DBX_IMAGE` in `.env`) and treat dbx and sidecar version bumps as a pair.
- We verified field shapes against dbx's Rust source rather than docs: `crates/dbx-core/src/models/connection.rs` (ConnectionConfig) and `crates/dbx-server/src/routes/connection.rs` (list/save handlers).

## Auth

- Password login, cookie session:
  - `POST /api/auth/login` with `{ "password": "..." }` → sets the `dbx_session` cookie. Always read the `set-cookie` header as a **list** (axios returns `headers['set-cookie']` as `string[]`, and the types lie about it).
  - `GET /api/auth/check` → `{ authenticated, required, setup_required }`. A missing/invalid session returns 200 with `authenticated: false`, not 401 — check the body, not the status.
  - Authed requests send the cookie verbatim: `Cookie: dbx_session=<value>`; `Path`/`HttpOnly` flags stay in the header, don't forward them.
- On a session-expiry response, clear the cookie and re-login **once**, then retry the request. A request that fails after re-auth is a real error, never retry it in a loop.
- **Lockouts are real**: repeated bad passwords trip a 429 (see the glossary's "lockout"). The client retries login at most once after a 60 s backoff (`LOCKOUT_BACKOFF_MS` in `src/dbx.ts`) and retries other failures only inside a fixed time budget.

## Connections

- `GET /api/connection/list` returns a **bare array** of ConnectionConfig (some versions may wrap in `{configs: [...]}` — accept both, see `DbxListResponseSchema`).
- `POST /api/connection/save` takes `{ "configs": [...] }` and replaces the entire list (`DbxSaveBodySchema`). There is no per-connection upsert endpoint — a full-list diff-and-save is the only write path.
- ConnectionConfig uses **snake_case** (`db_type`, `save_password`) and is a **closed Rust struct with no flatten catch-all**. That means:
  - fields unknown **to us** but known to dbx (`transport_layers`, `visible_databases`, `color`, ...) survive a read-modify-write because our schema (`z.looseObject`) keeps them and dbx deserializes them back;
  - fields unknown **to dbx** are *silently dropped* by serde on save — there is no free-form metadata field to hide our own state in.
  Use the loose schema so a round-trip never strips dbx-side data either way.
- The one safe place for sidecar state is the first-class `note` field (see below). dbx also manipulates `note` itself: `mongo_fallback_config_matches` clears it before comparing configs (v0.6.9 `crates/dbx-server/src/routes/connection.rs` ~line 203) — recheck that pattern on pin upgrades.
- `id` is a caller-chosen string; we use 16 hex chars of SHA-1 of the container name (`connectionId` in `src/reconcile-core.ts`) so the same container updates in place instead of duplicating. dbx UI-created connections get dbx-chosen ids, so collisions with our scheme are the adoption/conflict signal.
- Sending `save_password: false` **drops the stored credential** dbx holds for that connection. We always send `true`; dbx owns echoing that flag back, so the flag is excluded from change-detection (`sameConnection` in `src/reconcile-core.ts`).
- `database` is nullable; `port` is an integer.
- **Ownership marker**: the sidecar writes `managed by dbx-docker-sidecar — do not remove` into `note` on every connection it manages ("`MANAGED_NOTE`"). Exact match keys ownership; markerless connections are conserved verbatim in every save payload (`buildSavePayload`). Updates merge over the existing copy (`{...existing, ...desired}`) so dbx-side fields survive.

## Behaviour under startup

- dbx is not "up" when compose starts the sidecar: expect connection-refused, not just auth failures. Retry everything inside a bounded budget (120 s, capped backoff) rather than crash-looping — startup order must not matter.
- Distinguish "dbx container not found" (network not attached yet → defer network reconciliation, keep retrying) from "no connections yet" (fine, empty list).
