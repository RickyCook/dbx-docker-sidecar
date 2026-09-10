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
- ConnectionConfig uses **snake_case** (`db_type`, `save_password`) and treats **unknown fields as meaningful** (transport layers, visible databases). Use a loose schema (`z.looseObject`) so a read-modify-write round-trip never strips dbx-side data.
- `id` is a caller-chosen string; we use 16 hex chars of SHA-1 of the container name (`connectionId` in `src/reconcile-core.ts`) so the same container updates in place instead of duplicating.
- Sending `save_password: false` **drops the stored credential** dbx holds for that connection. We always send `true`; dbx owns echoing that flag back, so the flag is excluded from change-detection (`sameConnection` in `src/reconcile-core.ts`).
- `database` is nullable; `port` is an integer.

## Behaviour under startup

- dbx is not "up" when compose starts the sidecar: expect connection-refused, not just auth failures. Retry everything inside a bounded budget (120 s, capped backoff) rather than crash-looping — startup order must not matter.
- Distinguish "dbx container not found" (network not attached yet → defer network reconciliation, keep retrying) from "no connections yet" (fine, empty list).
