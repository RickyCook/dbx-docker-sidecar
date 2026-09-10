import { Retrier } from '@humanwhocodes/retry';
import { type AxiosInstance, isAxiosError } from 'axios';
import type { z } from 'zod';

import {
  DbxAuthCheckSchema,
  type DbxConnection,
  DbxListResponseSchema,
  type DbxSaveBody,
  DbxSaveBodySchema,
} from './dbx-schema.js';
import { childLogger } from './log.js';
import { type Sleep, sleep as sharedSleep } from './sleep.js';

const log = childLogger('dbx');

const LOCKOUT_BACKOFF_MS = 60_000;
const RETRY_BUDGET_MS = 120_000;
const RETRY_MAX_DELAY_MS = 5_000;
const SESSION_COOKIE = 'dbx_session';
const LOGIN_PATH = '/api/auth/login';
const CHECK_PATH = '/api/auth/check';
const LIST_PATH = '/api/connection/list';
const SAVE_PATH = '/api/connection/save';

export type { Sleep } from './sleep.js';

interface DbxLoginBody {
  readonly password: string;
}

// The two request payloads this client sends to dbx.
export type DbxWireBody = DbxSaveBody | DbxLoginBody | undefined;

export interface DbxHttpResponse {
  readonly status: number;
  readonly data: unknown;
  readonly setCookie: (name: string) => string | undefined;
}

export interface DbxHttpAdapter {
  request(
    method: 'GET' | 'POST',
    path: string,
    data: DbxWireBody,
    cookie: string | undefined,
  ): Promise<DbxHttpResponse>;
}

export class DbxError extends Error {}

export class DbxLoginError extends DbxError {
  readonly status: number;

  constructor(status: number) {
    super(`dbx login failed with status ${status}`);
    this.name = 'DbxLoginError';
    this.status = status;
  }
}

export class DbxLockoutError extends DbxError {}

export class DbxRequestError extends DbxError {
  readonly status: number;

  constructor(status: number, path: string) {
    super(`dbx request to ${path} failed with status ${status}`);
    this.name = 'DbxRequestError';
    this.status = status;
  }
}

export class DbxUnreachableError extends DbxError {
  readonly code: string;

  constructor(code: string) {
    super(`dbx unreachable: ${code}`);
    this.name = 'DbxUnreachableError';
    this.code = code;
  }
}

export class DbxProtocolError extends DbxError {}

// Turns a real AxiosInstance into the narrow adapter DbxClient injects.
// validateStatus is disabled so every HTTP status reaches the client, and
// network-level failures are normalized to DbxUnreachableError so the
// retry policy does not depend on axios internals.
export function axiosAdapter(axios: AxiosInstance): DbxHttpAdapter {
  return {
    request: async (method, path, data, cookie) => {
      const headers: Record<string, string> = cookie === undefined ? {} : { Cookie: cookie };
      const response = await axios
        .request({
          method,
          url: path,
          data: data ?? undefined,
          headers,
          validateStatus: () => true,
        })
        // SAFETY: axios normalizes network failures on Node with a stable
        // label (ECONNREFUSED, EAI_AGAIN, ...) exposed via its error factory
        // (isAxiosError); anything else falls to UNKNOWN. This is the
        // I/O boundary: the thrown value is opaque transport noise.
        // oxlint-disable anti-slop/no-unknown-parameters
        .catch((error: unknown): never => {
          if (isAxiosError(error)) {
            throw new DbxUnreachableError(error.code ?? 'UNKNOWN');
          }
          throw new DbxUnreachableError('UNKNOWN');
        });
      // oxlint-enable anti-slop/no-unknown-parameters
      return {
        status: response.status,
        data: response.data,
        setCookie: (name: string): string | undefined => {
          const values = response.headers['set-cookie'];
          if (!Array.isArray(values)) {
            return undefined;
          }
          // SAFETY: an http set-cookie header is a list of strings; axios types
          // it as unknown[] only because header values are unvalidated wire data.
          for (const value of values) {
            if (value.startsWith(`${name}=`)) return value;
          }
          return undefined;
        },
      };
    },
  };
}

/**
 * Thin cookie-session client for the dbx Web API.
 *
 * Save semantics are FULL-LIST REPLACE: saveConnections always transmits the
 * complete connection list, never a partial save; partial changes happen by
 * merging lists before calling. Credentials are persisted only when
 * save_password stays true, which the schema defaults for us.
 */
export class DbxClient {
  readonly #password: string;
  readonly #adapter: DbxHttpAdapter;
  readonly #sleep: Sleep;
  readonly #retryBudgetMs: number;
  readonly #retryMaxDelayMs: number;
  #sessionCookieInfo: string | undefined;

  constructor(
    password: string,
    adapter: DbxHttpAdapter,
    sleep: Sleep = sharedSleep,
    retryBudgetMs = RETRY_BUDGET_MS,
    retryMaxDelayMs = RETRY_MAX_DELAY_MS,
  ) {
    this.#password = password;
    this.#adapter = adapter;
    this.#sleep = sleep;
    this.#retryBudgetMs = retryBudgetMs;
    this.#retryMaxDelayMs = retryMaxDelayMs;
  }

  async authCheck(): Promise<boolean> {
    const response = await this.withNetworkRetry(() =>
      this.#adapter.request('GET', CHECK_PATH, undefined, this.#sessionCookieInfo),
    );
    if (response.status < 200 || response.status >= 300) {
      return false;
    }
    const check = this.#parse(DbxAuthCheckSchema, response.data);
    return check.required ? check.authenticated : true;
  }

  async login(): Promise<void> {
    try {
      await this.rawLogin();
    } catch (error: unknown) {
      if (error instanceof DbxLockoutError) {
        log.warn('dbx login lockout, backing off before one more attempt');
        await this.#sleep(LOCKOUT_BACKOFF_MS);
        await this.rawLogin();
      } else {
        throw error;
      }
    }
  }

  async listConnections(): Promise<readonly DbxConnection[]> {
    const response = await this.authedRequest('GET', LIST_PATH);
    return this.#parse(DbxListResponseSchema, response.data);
  }

  /**
   * Saves the COMPLETE connection list. dbx replaces everything it knows
   * with the payload of this call; anything not present is deleted.
   */
  async saveConnections(connections: readonly DbxConnection[]): Promise<void> {
    const body: DbxSaveBody = this.#parse(DbxSaveBodySchema, { configs: connections });
    const response = await this.authedRequest('POST', SAVE_PATH, body);
    if (response.status < 200 || response.status >= 300) {
      throw new DbxRequestError(response.status, SAVE_PATH);
    }
  }

  private async rawLogin(): Promise<void> {
    const response = await this.withNetworkRetry(() =>
      this.#adapter.request('POST', LOGIN_PATH, { password: this.#password }, undefined),
    );
    if (response.status === 429) {
      throw new DbxLockoutError();
    }
    if (response.status < 200 || response.status >= 300) {
      throw new DbxLoginError(response.status);
    }
    const cookie = response.setCookie(SESSION_COOKIE);
    if (cookie === undefined) {
      throw new DbxProtocolError('dbx login response does not set the dbx_session cookie');
    }
    this.#sessionCookieInfo = cookie;
  }

  private async authedRequest(
    method: 'GET' | 'POST',
    path: string,
    data?: DbxSaveBody,
  ): Promise<DbxHttpResponse> {
    return this.withNetworkRetry(() => this.#onceAuthed(method, path, data));
  }

  async #onceAuthed(
    method: 'GET' | 'POST',
    path: string,
    data?: DbxSaveBody,
  ): Promise<DbxHttpResponse> {
    if (this.#sessionCookieInfo === undefined) {
      log.debug('no dbx session yet, logging in');
      await this.login();
    }
    const response = await this.#adapter.request(method, path, data, this.#sessionCookieInfo);
    if (response.status !== 401) {
      return response;
    }
    this.#sessionCookieInfo = undefined;
    log.debug('dbx session expired, re-authenticating once');
    await this.login();
    const retried = await this.#adapter.request(method, path, data, this.#sessionCookieInfo);
    if (retried.status === 401) {
      throw new DbxRequestError(401, path);
    }
    return retried;
  }

  private withNetworkRetry<T>(call: () => Promise<T>): Promise<T> {
    // SAFETY: @humanwhocodes/retry hands this check every thrown value from
    // the retried call; instanceof discriminates reachable vs protocol errors.
    const retrier = new Retrier(
      // oxlint-disable-next-line anti-slop/no-unknown-parameters
      (error: unknown) => error instanceof DbxUnreachableError,
      {
        timeout: this.#retryBudgetMs,
        maxDelay: this.#retryMaxDelayMs,
      },
    );
    // Retrier offers no per-attempt hook; log each failed attempt here so
    // outages leave a warn trail instead of silence until budget exhaustion.
    let attempt = 0;
    return retrier.retry(() => {
      attempt += 1;
      // oxlint-disable-next-line anti-slop/no-unknown-parameters
      return call().catch((error: unknown) => {
        if (error instanceof DbxUnreachableError) {
          log.warn(
            { attempt, code: error.code },
            'dbx request failed; retrying while dbx is unreachable',
          );
        }
        throw error;
      });
    });
  }

  #parse<T>(
    schema: z.ZodType<T>,
    // SAFETY: this IS the I/O boundary parser; the zod schema validates the
    // untyped wire payload immediately on the very next statement.
    // oxlint-disable-next-line anti-slop/no-unknown-parameters
    data: unknown,
  ): T {
    const result = schema.safeParse(data);
    if (!result.success) {
      throw new DbxProtocolError(
        `dbx response shape mismatch: ${result.error.issues.length} issue(s)`,
      );
    }
    return result.data;
  }
}

export { LOCKOUT_BACKOFF_MS };
