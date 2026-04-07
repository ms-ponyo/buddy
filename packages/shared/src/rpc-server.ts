// packages/shared/src/rpc-server.ts
import { createServer, type Server, type Socket } from 'node:net';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  type JsonRpcRequest,
  type JsonRpcNotification,
  type JsonRpcResponse,
  type JsonRpcMessage,
  isRequest,
  isNotification,
  isResponse,
  RPC_ERRORS,
} from './rpc-types.js';

export type RpcHandler = (params: Record<string, unknown>, clientId: string) => Promise<unknown> | unknown;
export type NotificationHandler = (params: Record<string, unknown>) => void;

export interface RpcServerOptions {
  socketPath: string;
  onConnect?: (socket: Socket, id: string) => void;
  onDisconnect?: (id: string) => void;
}

export class RpcServer {
  private server: Server;
  private handlers = new Map<string, RpcHandler>();
  private notificationHandlers = new Map<string, NotificationHandler>();
  private clients = new Map<string, Socket>();
  private clientBuffers = new Map<string, string>();
  private nextClientId = 0;
  private nextRequestId = 1;
  private pendingClientCalls = new Map<string | number, {
    clientId: string;
    resolve: (value: unknown) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private socketPath: string;

  constructor(private options: RpcServerOptions) {
    this.socketPath = options.socketPath;
    mkdirSync(dirname(options.socketPath), { recursive: true });

    this.server = createServer((socket) => this.handleConnection(socket));
  }

  registerMethod(method: string, handler: RpcHandler): void {
    this.handlers.set(method, handler);
  }

  registerNotification(method: string, handler: NotificationHandler): void {
    this.notificationHandlers.set(method, handler);
  }

  async listen(): Promise<void> {
    // Clean up stale socket file
    if (existsSync(this.socketPath)) {
      unlinkSync(this.socketPath);
    }

    return new Promise((resolve, reject) => {
      this.server.on('error', reject);
      this.server.listen(this.socketPath, () => {
        this.server.removeListener('error', reject);
        resolve();
      });
    });
  }

  sendNotification(clientId: string, method: string, params?: Record<string, unknown>): void {
    const socket = this.clients.get(clientId);
    if (!socket || socket.destroyed) return;
    const notification: JsonRpcNotification = { jsonrpc: '2.0', method, params };
    socket.write(JSON.stringify(notification) + '\n');
  }

  broadcastNotification(method: string, params?: Record<string, unknown>): void {
    for (const clientId of this.clients.keys()) {
      this.sendNotification(clientId, method, params);
    }
  }

  getClient(clientId: string): Socket | undefined {
    return this.clients.get(clientId);
  }

  getClientIds(): string[] {
    return [...this.clients.keys()];
  }

  /**
   * Call a method on a connected client and await its response (reverse RPC).
   * Used by persistence to push deliver.message to consumers.
   */
  async callClient(clientId: string, method: string, params?: Record<string, unknown>, timeoutMs = 30000): Promise<unknown> {
    const socket = this.clients.get(clientId);
    if (!socket || socket.destroyed) {
      throw new Error(`Client ${clientId} not connected`);
    }

    const id = `s-${this.nextRequestId++}`;
    const request: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingClientCalls.delete(id);
        reject(new Error(`Reverse RPC call ${method} to client ${clientId} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingClientCalls.set(id, { clientId, resolve, reject, timer });
      socket.write(JSON.stringify(request) + '\n');
    });
  }

  async close(): Promise<void> {
    for (const [, pending] of this.pendingClientCalls) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Server closing'));
    }
    this.pendingClientCalls.clear();
    for (const socket of this.clients.values()) {
      socket.destroy();
    }
    this.clients.clear();
    this.clientBuffers.clear();

    return new Promise((resolve) => {
      this.server.close(() => {
        if (existsSync(this.socketPath)) {
          try { unlinkSync(this.socketPath); } catch {}
        }
        resolve();
      });
    });
  }

  private handleConnection(socket: Socket): void {
    const clientId = String(this.nextClientId++);
    this.clients.set(clientId, socket);
    this.clientBuffers.set(clientId, '');

    this.options.onConnect?.(socket, clientId);

    socket.on('data', (data) => {
      let buffer = (this.clientBuffers.get(clientId) || '') + data.toString();
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (line) {
          this.handleMessage(clientId, socket, line);
        }
      }
      this.clientBuffers.set(clientId, buffer);
    });

    socket.on('close', () => {
      this.clients.delete(clientId);
      this.clientBuffers.delete(clientId);
      this.rejectPendingForClient(clientId);
      this.options.onDisconnect?.(clientId);
    });

    socket.on('error', () => {
      this.clients.delete(clientId);
      this.clientBuffers.delete(clientId);
      this.rejectPendingForClient(clientId);
    });
  }

  private async handleMessage(clientId: string, socket: Socket, raw: string): Promise<void> {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      this.sendError(socket, null, RPC_ERRORS.PARSE_ERROR, 'Parse error');
      return;
    }

    // Handle responses to our callClient() requests
    if (isResponse(msg)) {
      const pending = this.pendingClientCalls.get(msg.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingClientCalls.delete(msg.id);
        if (msg.error) {
          pending.reject(new Error(`Reverse RPC error ${msg.error.code}: ${msg.error.message}`));
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }

    if (isRequest(msg)) {
      const handler = this.handlers.get(msg.method);
      if (!handler) {
        this.sendError(socket, msg.id, RPC_ERRORS.METHOD_NOT_FOUND, `Method not found: ${msg.method}`);
        return;
      }
      try {
        const result = await handler(msg.params || {}, clientId);
        const response: JsonRpcResponse = { jsonrpc: '2.0', id: msg.id, result: result ?? {} };
        socket.write(JSON.stringify(response) + '\n');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.sendError(socket, msg.id, RPC_ERRORS.INTERNAL_ERROR, message);
      }
      return;
    }

    if (isNotification(msg)) {
      const handler = this.notificationHandlers.get(msg.method);
      if (handler) {
        handler(msg.params || {});
      }
      return;
    }
  }

  private rejectPendingForClient(clientId: string): void {
    for (const [id, pending] of this.pendingClientCalls) {
      if (pending.clientId === clientId) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Client disconnected'));
        this.pendingClientCalls.delete(id);
      }
    }
  }

  private sendError(socket: Socket, id: string | number | null, code: number, message: string): void {
    const response: JsonRpcResponse = {
      jsonrpc: '2.0',
      id: id ?? 0,
      error: { code, message },
    };
    socket.write(JSON.stringify(response) + '\n');
  }
}
