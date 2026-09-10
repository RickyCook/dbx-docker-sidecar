import Docker from 'dockerode';

import { childLogger } from './log.js';

const log = childLogger('docker');

export function dockerClient(): Docker {
  return new Docker({ socketPath: '/var/run/docker.sock' });
}

export async function pingDocker(docker: Docker): Promise<number> {
  const containers = await docker.listContainers();
  return containers.length;
}

export function logPing(count: number): void {
  log.info({ runningContainers: count }, 'docker daemon ping');
}
