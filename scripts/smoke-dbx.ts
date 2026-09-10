import axios from 'axios';

import { axiosAdapter, DbxClient } from '../src/dbx.js';

const dbxUrl = process.env.DBX_URL ?? 'http://localhost:4224';
const password = process.env.DBX_PASSWORD ?? '';

function fatal(message: string): never {
  console.error(`smoke-dbx: ${message}`);
  process.exit(1);
}

if (password === '') {
  fatal('set DBX_PASSWORD (and optionally DBX_URL) to run against a live dbx');
}

const dbx = new DbxClient(password, axiosAdapter(axios.create({ baseURL: dbxUrl })));

try {
  await dbx.login();
} catch (error: unknown) {
  fatal(`login failed: ${String(error)}`);
}
console.log('ok: login captured dbx_session');

const configured = await dbx.authCheck();
if (!configured) {
  fatal('authCheck still reports unauthenticated after login');
}

const before = await dbx.listConnections();
console.log(`ok: listConnections found ${before.length} profiles`);

const probe = {
  id: 'sidecar-smoke-probe',
  name: 'sidecar-smoke-probe',
  db_type: 'postgres',
  host: 'localhost',
  port: 5432,
  username: 'sidecar',
  password: '',
  database: null,
  save_password: true,
};

try {
  await dbx.saveConnections([...before, probe]);
} catch (error: unknown) {
  fatal(`save failed: ${String(error)}`);
}

const after = await dbx.listConnections();
console.log(`ok: listConnections after save found ${after.length} profiles`);
const removed = after.filter((connection) => connection.id !== probe.id);

await dbx.saveConnections(removed);
const finalList = await dbx.listConnections();
console.log(`smoke-dbx done against ${dbxUrl}: profiles restored to ${finalList.length}`);
