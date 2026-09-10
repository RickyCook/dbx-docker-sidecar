import { z } from 'zod';

// dbx serializes ConnectionConfig with snake_case field names and treats
// unknown fields as meaningful (transport layers, visible databases, ...).
// A loose schema guarantees a save round-trip never drops dbx-side data.
// See crates/dbx-core/src/models/connection.rs in the dbx source.
export const DbxConnectionSchema = z.looseObject({
  id: z.string().min(1),
  name: z.string(),
  db_type: z.string().min(1),
  host: z.string(),
  port: z.number().int(),
  username: z.string(),
  password: z.string(),
  database: z.nullable(z.string()),
  save_password: z.boolean().default(true),
  // First-class user note in dbx's ConnectionConfig. The sidecar writes its
  // ownership marker here (see reconcile-core.ts); exact-match is the only
  // form that survives a read-modify-write cycle — dbx's struct is closed,
  // so fields unknown to dbx are silently dropped on save.
  note: z.string().default(''),
});

export type DbxConnection = z.output<typeof DbxConnectionSchema>;

export const DbxAuthCheckSchema = z.object({
  authenticated: z.boolean(),
  required: z.boolean(),
  setup_required: z.boolean(),
});

export type DbxAuthCheck = z.output<typeof DbxAuthCheckSchema>;

// GET /api/connection/list returns a bare Vec<ConnectionConfig>
// (routes/connection.rs::load_connections in the dbx source).
export const DbxListResponseSchema = z.union([
  z.array(DbxConnectionSchema),
  z.looseObject({ configs: z.array(DbxConnectionSchema) }).transform(({ configs }) => configs),
]);

// POST /api/connection/save wraps the full list in an envelope named
// "configs" (SaveConnectionsRequest in the same source file). Saving
// replaces the entire list and drops stored credentials for connections
// sent with save_password: false, so the client always sends it as true.
export const DbxSaveBodySchema = z.object({
  configs: z.array(DbxConnectionSchema),
});

export type DbxSaveBody = z.output<typeof DbxSaveBodySchema>;
