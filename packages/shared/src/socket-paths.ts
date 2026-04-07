// packages/shared/src/socket-paths.ts
const SOCKET_DIR = process.env.WORKER_SOCKET_DIR || '/tmp/buddy';

export const PERSISTENCE_SOCKET = `${SOCKET_DIR}/persistence.sock`;
export const GATEWAY_SOCKET = process.env.GATEWAY_SOCKET_PATH || `${SOCKET_DIR}/gateway.sock`;

export function workerSocketPath(threadKey: string): string {
  const safe = threadKey.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `${SOCKET_DIR}/worker-${safe}.sock`;
}

export function liteWorkerSocketPath(threadKey: string, purpose: string): string {
  const safe = threadKey.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `${SOCKET_DIR}/lite-worker-${safe}-${purpose}.sock`;
}

// ensureSocketDir removed — RpcServer now creates parent dir dynamically
