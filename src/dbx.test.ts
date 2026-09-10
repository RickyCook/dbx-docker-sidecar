import axios from 'axios';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  axiosAdapter,
  DbxClient,
  DbxError,
  DbxLoginError,
  DbxProtocolError,
  LOCKOUT_BACKOFF_MS,
} from './dbx.js';
import {
  DbxAuthCheckSchema,
  DbxConnectionSchema,
  DbxListResponseSchema,
  DbxSaveBodySchema,
} from './dbx-schema.js';

const SET_COOKIE = 'dbx_session=tok123; Path=/; HttpOnly';
const BASE_URL = 'http://dbx.test';
const LOGIN = `${BASE_URL}/api/auth/login`;
const CHECK = `${BASE_URL}/api/auth/check`;
const LIST = `${BASE_URL}/api/connection/list`;
const SAVE = `${BASE_URL}/api/connection/save`;

const CONNECTION = {
  id: 'c1',
  name: 'order-db',
  db_type: 'postgres',
  host: 'db.internal',
  port: 5432,
  username: 'root',
  password: 'hunter2',
  database: null,
  save_password: true,
  note: '',
};

const server = setupServer();
server.events.on('request:unhandled', ({ request }) => {
  throw new Error(`unhandled msw request: ${request.method} ${request.url}`);
});

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function loginOk() {
  const response = HttpResponse.json(null);
  response.headers.set('set-cookie', SET_COOKIE);
  return response;
}

function okList() {
  return HttpResponse.json([CONNECTION]);
}

function makeClient(
  options: { sleep?: (ms: number) => Promise<void>; retryBudgetMs?: number } = {},
): DbxClient {
  const axiosInstance = axios.create({ baseURL: BASE_URL });
  return new DbxClient(
    'secret',
    axiosAdapter(axiosInstance),
    options.sleep,
    options.retryBudgetMs ?? 200,
    10,
  );
}

describe('dbx-schema', () => {
  it('requires core snake_case fields on connection configs', () => {
    const parsed = DbxConnectionSchema.parse({ ...CONNECTION, transport_layers: ['a'] });
    expect(parsed).toMatchObject({ ...CONNECTION, transport_layers: ['a'] });
  });

  it('defaults save_password to true', () => {
    const parsed = DbxConnectionSchema.parse(CONNECTION);
    expect(parsed.save_password).toBe(true);
  });

  it('rejects malformed connection configs', () => {
    expect(DbxConnectionSchema.safeParse({ ...CONNECTION, port: '5432' }).success).toBe(false);
  });

  it('parses list responses both bare and enveloped to the same array', () => {
    expect(DbxListResponseSchema.parse([CONNECTION])).toEqual([CONNECTION]);
    expect(DbxListResponseSchema.parse({ configs: [CONNECTION] })).toEqual([CONNECTION]);
  });

  it('validates auth-check and save-body shapes', () => {
    expect(
      DbxAuthCheckSchema.safeParse({ authenticated: false, required: true, setup_required: false })
        .success,
    ).toBe(true);
    const { configs } = DbxSaveBodySchema.parse({
      configs: [{ ...CONNECTION, save_password: false }],
    });
    expect(configs[0]).toMatchObject({ save_password: false });
  });
});

describe('DbxClient', () => {
  it('logs in fresh and reuses the session cookie on subsequent calls', async () => {
    let loginCount = 0;
    let firstListCookie: string | undefined;
    let secondListCookie: string | undefined;
    server.use(
      http.post(LOGIN, () => {
        loginCount += 1;
        return loginOk();
      }),
      http.get(LIST, ({ request }) => {
        const cookie = request.headers.get('cookie') ?? undefined;
        if (firstListCookie === undefined) {
          firstListCookie = cookie;
        } else {
          secondListCookie = cookie;
        }
        return okList();
      }),
    );
    const client = makeClient();

    const firstList = await client.listConnections();
    const secondList = await client.listConnections();

    expect(firstList).toEqual([CONNECTION]);
    expect(secondList).toEqual([CONNECTION]);
    expect(loginCount).toBe(1);
    expect(firstListCookie).toBe(SET_COOKIE);
    expect(secondListCookie).toBe(SET_COOKIE);
  });

  it('re-logins exactly once on 401 and retries the original request', async () => {
    let loginCount = 0;
    let listCalls = 0;
    server.use(
      http.post(LOGIN, () => {
        loginCount += 1;
        return loginOk();
      }),
      http.get(LIST, () => {
        listCalls += 1;
        if (listCalls === 1) {
          return new HttpResponse(null, { status: 401 });
        }
        return okList();
      }),
    );
    const client = makeClient();

    const list = await client.listConnections();

    expect(list).toEqual([CONNECTION]);
    expect(loginCount).toBe(2);
    expect(listCalls).toBe(2);
  });

  it('backs off for the dbx lockout then finishes with a single original retry', async () => {
    let loginCount = 0;
    let listCalls = 0;
    const sleep = vi.fn(async () => undefined);
    server.use(
      http.post(LOGIN, () => {
        loginCount += 1;
        if (loginCount === 1) {
          return new HttpResponse(null, { status: 429 });
        }
        return loginOk();
      }),
      http.get(LIST, () => {
        listCalls += 1;
        if (listCalls === 1) {
          return new HttpResponse(null, { status: 401 });
        }
        return okList();
      }),
    );
    const client = makeClient({ sleep: sleep as unknown as (ms: number) => Promise<void> });

    const list = await client.listConnections();

    expect(list).toEqual([CONNECTION]);
    expect(loginCount).toBe(3);
    expect(sleep).toHaveBeenCalledWith(LOCKOUT_BACKOFF_MS);
    expect(listCalls).toBe(2);
  });

  it('propagates login failure status instead of hammering with retries', async () => {
    server.use(
      http.post(LOGIN, () => new HttpResponse(null, { status: 401 })),
      http.get(LIST, () => new HttpResponse(null, { status: 401 })),
    );
    const client = makeClient();

    await expect(client.listConnections()).rejects.toThrow(DbxLoginError);
  });

  it('gives up after the second consecutive 429 lockout and rethrows', async () => {
    let loginCount = 0;
    const sleep = vi.fn(async () => undefined);
    server.use(
      http.post(LOGIN, () => {
        loginCount += 1;
        return new HttpResponse(null, { status: 429 });
      }),
      http.get(LIST, () => new HttpResponse(null, { status: 401 })),
    );
    const client = makeClient({ sleep: sleep as unknown as (ms: number) => Promise<void> });

    await expect(client.listConnections()).rejects.toThrow(DbxError);
    expect(loginCount).toBe(2);
    expect(sleep).toHaveBeenCalledWith(LOCKOUT_BACKOFF_MS);
  });

  it('gives up after the retry budget when dbx stays unreachable', async () => {
    server.use(
      http.post(LOGIN, () => HttpResponse.error()),
      http.get(LIST, () => HttpResponse.error()),
    );
    const client = makeClient({ retryBudgetMs: 200 });

    await expect(client.listConnections()).rejects.toThrow();
  });

  it('sends the full-list payload with save_password true and the session cookie', async () => {
    let savedBody: unknown = null;
    let savedCookie: string | undefined;
    let saveCalls = 0;
    server.use(
      http.post(LOGIN, () => loginOk()),
      http.post(SAVE, async ({ request }) => {
        saveCalls += 1;
        if (saveCalls === 1) {
          return new HttpResponse(null, { status: 401 });
        }
        savedCookie = request.headers.get('cookie') ?? undefined;
        savedBody = await request.json();
        return HttpResponse.json(null);
      }),
    );
    const client = makeClient();

    const parsedConnection = DbxConnectionSchema.parse({ ...CONNECTION });
    await client.saveConnections([parsedConnection]);

    expect(savedBody).toEqual({ configs: [{ ...CONNECTION, save_password: true }] });
    expect(savedCookie).toBe(SET_COOKIE);
  });

  it('requires the dbx_session cookie on a successful login', async () => {
    server.use(http.post(LOGIN, () => HttpResponse.json(null)));
    const client = makeClient();

    await expect(client.login()).rejects.toThrow(DbxProtocolError);
  });

  it('reflects auth state as unauthenticated until login succeeds', async () => {
    let loginCount = 0;
    server.use(
      http.get(CHECK, () =>
        HttpResponse.json({ authenticated: loginCount > 0, required: true, setup_required: false }),
      ),
      http.post(LOGIN, () => {
        loginCount += 1;
        return loginOk();
      }),
    );
    const client = makeClient();

    expect(await client.authCheck()).toBe(false);
    await client.login();
    expect(await client.authCheck()).toBe(true);
  });

  it('treats passwordless dbx as always-authenticated', async () => {
    server.use(
      http.get(CHECK, () =>
        HttpResponse.json({ authenticated: false, required: false, setup_required: false }),
      ),
    );
    const client = makeClient();

    expect(await client.authCheck()).toBe(true);
  });
});
