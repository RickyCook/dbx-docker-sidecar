import { z } from 'zod';

import { childLogger } from './log.js';
import { sleep } from './sleep.js';

const log = childLogger('events');

const RECONNECT_DELAY_MS = 1_000;

// Docker event wire entry from GET /events.
export const DockerEventSchema = z.object({
  Type: z.string(),
  Action: z.string(),
});
export type DockerEvent = z.infer<typeof DockerEventSchema>;

export interface EventSource {
  start(onEvent: (event: DockerEvent) => void): void;
  stop(): Promise<void>;
}

// Minimal stream facade over a docker event response.
export interface EventStream {
  setEncoding?(encoding: string): void;
  on(event: 'data', listener: (chunk: string) => void): void;
  on(event: 'close', listener: () => void): void;
  on(event: 'error', listener: () => void): void;
  destroy?(): void;
}

export type EventPoller = {
  getEvents(options: { filters: Record<string, string[]> }): Promise<EventStream>;
};

// Auto-reconnecting event stream: container + network events, chunked lines,
// reconnect one second after the daemon drops or errors out. Unparseable
// lines are dropped with a warning, never crash the loop.
export class DockerEventSource implements EventSource {
  readonly #docker: EventPoller;
  readonly #buffer = { value: '' };
  #onEvent: ((event: DockerEvent) => void) | undefined;
  #running = false;
  #stream: EventStream | undefined;
  #loop: Promise<void> = Promise.resolve();

  constructor(docker: EventPoller) {
    this.#docker = docker;
  }

  start(onEvent: (event: DockerEvent) => void): void {
    if (this.#running) {
      return;
    }
    this.#onEvent = onEvent;
    this.#running = true;
    this.#loop = this.#connectLoop();
  }

  async stop(): Promise<void> {
    this.#running = false;
    this.#stream?.destroy?.();
    this.#stream = undefined;
    await this.#loop;
  }

  async #connectLoop(): Promise<void> {
    while (this.#running) {
      let stream: EventStream;
      try {
        stream = await this.#docker.getEvents({
          filters: { type: ['container', 'network'] },
        });
      } catch (error: unknown) {
        log.warn({ err: error }, 'docker event stream could not open; retrying');
        await sleep(RECONNECT_DELAY_MS);
        continue;
      }
      if (!this.#running) {
        stream.destroy?.();
        break;
      }
      // SAFETY: a GET /events stream is plain newline-delimited JSON; dockerode
      // hands the response straight through, and the schema above validates
      // each entry before it reaches the handler.
      await new Promise<void>((resolve) => {
        stream.setEncoding?.('utf8');
        stream.on('data', (chunk: string) => {
          this.#handleChunk(chunk);
        });
        stream.on('close', () => resolve());
        stream.on('error', () => {
          log.warn('docker event stream errored');
          resolve();
        });
      });
      if (this.#running) {
        log.warn('docker event stream ended; reconnecting');
        await sleep(RECONNECT_DELAY_MS);
      }
    }
  }

  #handleChunk(chunk: string): void {
    this.#buffer.value += chunk;
    const lines = this.#buffer.value.split('\n');
    this.#buffer.value = lines.pop() ?? '';
    for (const line of lines) {
      if (line === '') {
        continue;
      }
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        log.warn({ line: line.slice(0, 200) }, 'unparseable docker event dropped');
        continue;
      }
      const parsed = DockerEventSchema.safeParse(entry);
      if (!parsed.success) {
        log.warn({ line: line.slice(0, 200) }, 'unparseable docker event dropped');
        continue;
      }
      this.#onEvent?.(parsed.data);
    }
  }
}
