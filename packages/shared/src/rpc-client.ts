// packages/shared/src/rpc-client.ts
import { connect, type Socket } from 'node:net';
import {
  type JsonRpcRequest,
  type JsonRpcNotification,
  type JsonRpcResponse,
  type JsonRpcMessage,
  isResponse,
  isNotification,
  isRequest,
} from './rpc-types.js';

export interface RpcClientOptions {
  socketPath: string;
  reconnect?: boolean;          // Default true
  maxReconnectDelay?: number;   // Default 5000ms
  onNotification?: (method: string, params: Record<string, unknown>) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
}

export class RpcClient {
  private socket: Socket | null = null;
  private buffer = '';
  private nextId = 1;
  private methods = new Map<string, (params: Record<string, unknown>) => Promise<unknown> | unknown>();
  private pending = new Map<string | number, {
    resolve: (value: unknown) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private connected = false;
  private wasConnected = false;  // True once a connection has been established at least once
  private reconnectDelay = 100;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private closing = false;

  constructor(private options: RpcClientOptions) {}

  registerMethod(method: string, handler: (params: Record<string, unknown>) => Promise<unknown> | unknown): void {
    this.methods.set(method, handler);
  }

  get isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<void> {
    this.closing = false;
    return new Promise((resolve, reject) => {
      this.socket = connect(this.options.socketPath);

      this.socket.on('connect', () => {
        this.connected = true;
        this.wasConnected = true;
        this.reconnectDelay = 100; // Reset backoff
        this.options.onConnect?.();
        resolve();
      });

      this.socket.on('data', (data) => {
        this.buffer += data.toString();
        let newlineIdx: number;
        while ((newlineIdx = this.buffer.indexOf('\n')) !== -1) {
          const line = this.buffer.slice(0, newlineIdx).trim();
          this.buffer = this.buffer.slice(newlineIdx + 1);
          if (line) this.handleMessage(line);
        }
      });

      this.socket.on('close', () => {
        const hadConnection = this.connected;
        this.connected = false;
        this.rejectAllPending('Connection closed');
        if (hadConnection) this.options.onDisconnect?.();
        // Auto-reconnect if enabled — both after connection loss and initial failure
        if (!this.closing && (this.options.reconnect ?? true)) {
          this.scheduleReconnect();
        }
      });

      this.socket.on('error', (err) => {
        if (!this.connected) {
          reject(err);
        }
      });
    });
  }

  async call(method: string, params?: Record<string, unknown>, timeoutMs = 30000): Promise<unknown> {
    if (!this.connected || !this.socket) {
      throw new Error(`RPC client not connected (calling ${method})`);
    }

    const id = this.nextId++;
    const request: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC call ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.socket!.write(JSON.stringify(request) + '\n');
    });
  }

  notify(method: string, params?: Record<string, unknown>): void {
    if (!this.connected || !this.socket) return;
    const notification: JsonRpcNotification = { jsonrpc: '2.0', method, params };
    this.socket.write(JSON.stringify(notification) + '\n');
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.rejectAllPending('Client closing');
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.connected = false;
  }

  private async handleMessage(raw: string): Promise<void> {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return; // Ignore unparseable messages
    }

    if (isResponse(msg)) {
      const pending = this.pending.get(msg.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(msg.id);
        if (msg.error) {
          pending.reject(new Error(`RPC error ${msg.error.code}: ${msg.error.message}`));
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }

    if (isRequest(msg)) {
      const handler = this.methods.get(msg.method);
      if (!handler) {
        const errorResponse: JsonRpcResponse = {
          jsonrpc: '2.0', id: msg.id,
          error: { code: -32601, message: `Method not found: ${msg.method}` },
        };
        this.socket!.write(JSON.stringify(errorResponse) + '\n');
        return;
      }
      try {
        const result = await handler(msg.params || {});
        const response: JsonRpcResponse = { jsonrpc: '2.0', id: msg.id, result: result ?? {} };
        this.socket!.write(JSON.stringify(response) + '\n');
      } catch (err) {
        const errorResponse: JsonRpcResponse = {
          jsonrpc: '2.0', id: msg.id,
          error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
        };
        this.socket!.write(JSON.stringify(errorResponse) + '\n');
      }
      return;
    }

    if (isNotification(msg)) {
      this.options.onNotification?.(msg.method, msg.params as Record<string, unknown> || {});
      return;
    }
  }

  private rejectAllPending(reason: string): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
  }

  private scheduleReconnect(): void {
    if (this.closing) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(delay * 2, this.options.maxReconnectDelay ?? 5000);

    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect();
      } catch {
        // connect() failure triggers 'close' → scheduleReconnect() again
      }
    }, delay);
  }
}
