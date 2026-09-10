# 0001 — Conserve unmanaged dbx connections

Date: 2026-09-10 · Status: accepted

## Context

Reconciliation writes dbx connections with a full-list save: the desired list IS
the payload. The original sidecar design was deliberately full-control —
"connections created in the dbx UI are wiped at the next sync" (CONTEXT.md,
"Owned lists"). That was predicated on every meaningful connection originating
from a labeled container.

In practice dbx is also the place to hold connections to databases the sidecar
cannot see: managed cloud databases, bare-metal hosts, anything not in Docker.
Wiping those on every sync makes the sidecar unusable unless it sees everything.

The obvious fix — an extra "managed by sidecar" field on connections we write —
does not survive the wire: dbx's `ConnectionConfig` is a closed serde struct
without a flatten catch-all, so fields unknown to dbx are silently dropped on
save (verified against the pinned v0.6.9 source, `crates/dbx-core/src/models/
connection.rs`). The only round-trip-safe free-form field is the first-class
`note` field.

## Decision

- The sidecar marks its connections by writing `managed by dbx-docker-sidecar
  — do not remove` into `note` (`MANAGED_NOTE`). Ownership is keyed on the
  **exact** note text, never a substring.
- Removal is gated on ownership: only managed connections whose container is
  gone are removed. Unmanaged connections ride in every save payload verbatim;
  dbx-side fields they may carry survive because we pass the objects through
  untouched.
- We never override a config based on id/name equality alone. A markerless
  connection with a colliding derived id is a **conflict**: logged as an error,
  never added, updated, or removed.
- One carve-out — **adoption**: markerless connections whose compared fields
  match the derived connection exactly gain only the marker. This exists for
  the pre-marker upgrade: connections written by earlier sidecar versions have
  our id scheme but no marker, and erroring on them would demand a manual
  wipe of every connection at upgrade time.
- Updates now merge over the existing copy (`{...existing, ...desired fields}`)
  instead of rebuilding from scratch, so dbx-side fields (`color`, `ssl`,
  timeouts, ...) also survive saves of managed connections.
- Markerless adoption/conflict semantics mean **exact** note edits by a user on
  a managed connection un-manage it; the sidecar will not silently take it back
  (fields would need to continue matching to be readopted).

Network attachment policy is unchanged: still full-control (manual attachments
are pruned). Reversing that is out of scope.

## Consequences

- Hand-created connections persist across syncs; dbx becomes usable as the
  single connection registry.
- The conflict path leaves a labeled container unmanaged until a human resolves
  the collision in the dbx UI. Surfaced at error level each pass so it is not
  silently ignored.
- Users can un-manage a connection by rewriting its note (documented escape
  hatch), and can also do it by deleting the marker text accidentally — the
  conflict/conservation semantics make that safe rather than catastrophic.
- The marker text is coupled to dbx's `note` field behavior under the pinned
  dbx version; pin upgrades must re-verify (see docs/agents/dbx.md).
