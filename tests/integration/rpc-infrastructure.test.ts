import { jest } from '@jest/globals';
import { RpcServer, RpcClient } from '../../packages/shared/src/index.js';
import { createTempSocket } from './helpers/test-helpers.js';

describe('RPC Infrastructure', () => {
  let server: RpcServer;
  let client: RpcClient;
  let socketPath: string;
  let cleanupSocket: () => void;

  beforeEach(async () => {
    const temp = createTempSocket('rpc-infra');
    socketPath = temp.socketPath;
    cleanupSocket = temp.cleanup;
  });

  afterEach(async () => {
    await client?.close();
    await server?.close();
    cleanupSocket?.();
  });

  it('client connects to server over real Unix socket', async () => {
    server = new RpcServer({ socketPath });
    server.registerMethod('ping', () => ({ pong: true }));
    await server.listen();

    client = new RpcClient({ socketPath, reconnect: false });
    await client.connect();
    expect(client.isConnected).toBe(true);
  });

  it('client calls registered method, gets correct result', async () => {
    server = new RpcServer({ socketPath });
    server.registerMethod('add', async (params) => {
      const { a, b } = params as { a: number; b: number };
      return { sum: a + b };
    });
    await server.listen();

    client = new RpcClient({ socketPath, reconnect: false });
    await client.connect();

    const result = await client.call('add', { a: 3, b: 4 });
    expect(result).toEqual({ sum: 7 });
  });

  it('client receives JSON-RPC error for unknown method', async () => {
    server = new RpcServer({ socketPath });
    await server.listen();

    client = new RpcClient({ socketPath, reconnect: false });
    await client.connect();

    await expect(client.call('nonexistent')).rejects.toThrow('Method not found');
  });

  it('server broadcasts notification to multiple clients', async () => {
    server = new RpcServer({ socketPath });
    await server.listen();

    const notifications1: any[] = [];
    const notifications2: any[] = [];

    const client1 = new RpcClient({
      socketPath,
      reconnect: false,
      onNotification: (method, params) => notifications1.push({ method, params }),
    });
    const client2 = new RpcClient({
      socketPath,
      reconnect: false,
      onNotification: (method, params) => notifications2.push({ method, params }),
    });

    await client1.connect();
    await client2.connect();
    await new Promise((r) => setTimeout(r, 50));

    server.broadcastNotification('test.broadcast', { msg: 'hello' });
    await new Promise((r) => setTimeout(r, 50));

    expect(notifications1).toHaveLength(1);
    expect(notifications1[0].method).toBe('test.broadcast');
    expect(notifications2).toHaveLength(1);

    await client1.close();
    await client2.close();
    // Set client to client1 for afterEach cleanup reference (already closed)
    client = client1;
  });

  it('client auto-reconnects after server restart', async () => {
    server = new RpcServer({ socketPath });
    server.registerMethod('ping', () => ({ pong: true }));
    await server.listen();

    const connectCount = { value: 0 };
    client = new RpcClient({
      socketPath,
      reconnect: true,
      maxReconnectDelay: 200,
      onConnect: () => { connectCount.value++; },
    });
    await client.connect();
    expect(connectCount.value).toBe(1);

    // Kill and restart server
    await server.close();
    await new Promise((r) => setTimeout(r, 100));

    server = new RpcServer({ socketPath });
    server.registerMethod('ping', () => ({ pong: true }));
    await server.listen();

    // Wait for reconnect
    await new Promise((r) => setTimeout(r, 500));
    expect(client.isConnected).toBe(true);
    expect(connectCount.value).toBe(2);

    // Verify the reconnected client can make calls
    const result = await client.call('ping');
    expect(result).toEqual({ pong: true });
  });

  it('multiple clients identified independently via clientId', async () => {
    const clientIds: string[] = [];
    server = new RpcServer({
      socketPath,
      onConnect: (_socket, id) => { clientIds.push(id); },
    });
    server.registerMethod('whoami', (_params, clientId) => ({ clientId }));
    await server.listen();

    const client1 = new RpcClient({ socketPath, reconnect: false });
    const client2 = new RpcClient({ socketPath, reconnect: false });
    await client1.connect();
    await client2.connect();

    const id1 = await client1.call('whoami') as { clientId: string };
    const id2 = await client2.call('whoami') as { clientId: string };

    expect(id1.clientId).not.toBe(id2.clientId);
    expect(clientIds).toHaveLength(2);

    await client1.close();
    await client2.close();
    client = client1;
  });

  it('request timeout fires when server does not respond', async () => {
    server = new RpcServer({ socketPath });
    server.registerMethod('hang', async () => {
      await new Promise((r) => setTimeout(r, 10000));
      return {};
    });
    await server.listen();

    client = new RpcClient({ socketPath, reconnect: false });
    await client.connect();

    await expect(client.call('hang', {}, 200)).rejects.toThrow('timed out');
  });
});
