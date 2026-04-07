import { jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RpcServer } from '../../packages/shared/src/rpc-server.js';
import { RpcClient } from '../../packages/shared/src/rpc-client.js';

const tempDir = mkdtempSync(join(tmpdir(), 'rpc-client-test-'));
let socketCounter = 0;
function nextSocket(): string {
  return join(tempDir, `test-${socketCounter++}.sock`);
}

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('RpcClient', () => {
  let server: RpcServer;
  let client: RpcClient;
  let socketPath: string;

  beforeEach(async () => {
    socketPath = nextSocket();
    server = new RpcServer({ socketPath });
    server.registerMethod('echo', async (params) => ({ echoed: params }));
    server.registerMethod('slow', async () => {
      await new Promise((r) => setTimeout(r, 5000));
      return { done: true };
    });
    await server.listen();
  });

  afterEach(async () => {
    await client?.close();
    await server?.close();
  });

  it('call sends request and resolves with result', async () => {
    client = new RpcClient({ socketPath, reconnect: false });
    await client.connect();

    const result = await client.call('echo', { hello: 'world' });
    expect(result).toEqual({ echoed: { hello: 'world' } });
  });

  it('call rejects on timeout', async () => {
    client = new RpcClient({ socketPath, reconnect: false });
    await client.connect();

    await expect(client.call('slow', {}, 100)).rejects.toThrow('timed out');
  });

  it('call rejects on JSON-RPC error response', async () => {
    client = new RpcClient({ socketPath, reconnect: false });
    await client.connect();

    await expect(client.call('nonexistent')).rejects.toThrow('Method not found');
  });

  it('notify sends fire-and-forget', async () => {
    const received = jest.fn<() => void>();
    server.registerNotification('test.ping', received);

    client = new RpcClient({ socketPath, reconnect: false });
    await client.connect();

    client.notify('test.ping', { ts: Date.now() });
    await new Promise((r) => setTimeout(r, 50));

    expect(received).toHaveBeenCalledTimes(1);
  });

  it('reconnect fires after established connection drops', async () => {
    const onConnect = jest.fn<() => void>();
    const onDisconnect = jest.fn<() => void>();

    client = new RpcClient({
      socketPath,
      reconnect: true,
      maxReconnectDelay: 200,
      onConnect,
      onDisconnect,
    });
    await client.connect();
    expect(onConnect).toHaveBeenCalledTimes(1);

    // Stop server — client should disconnect then reconnect when server restarts
    await server.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(onDisconnect).toHaveBeenCalledTimes(1);

    // Restart server on same path
    server = new RpcServer({ socketPath });
    server.registerMethod('echo', async (params) => ({ echoed: params }));
    await server.listen();

    // Wait for reconnect
    await new Promise((r) => setTimeout(r, 500));
    expect(client.isConnected).toBe(true);
    expect(onConnect).toHaveBeenCalledTimes(2);
  });

  it('no reconnect on initial connect failure', async () => {
    const badPath = join(tempDir, 'nonexistent.sock');
    client = new RpcClient({ socketPath: badPath, reconnect: true });

    await expect(client.connect()).rejects.toThrow();
    // Should not attempt reconnect — wait and verify
    await new Promise((r) => setTimeout(r, 500));
    expect(client.isConnected).toBe(false);
  });
});
