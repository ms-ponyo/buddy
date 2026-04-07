import { jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { connect, type Socket } from 'node:net';
import { RpcServer } from '../../packages/shared/src/rpc-server.js';

const tempDir = mkdtempSync(join(tmpdir(), 'rpc-server-test-'));
let socketCounter = 0;
function nextSocket(): string {
  return join(tempDir, `test-${socketCounter++}.sock`);
}

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

/** Helper: connect a raw socket and send/receive JSON-RPC messages */
function rawConnect(socketPath: string): Promise<{ socket: Socket; send: (msg: any) => void; receive: () => Promise<any> }> {
  return new Promise((resolve) => {
    const socket = connect(socketPath, () => {
      let buffer = '';
      const pending: Array<(msg: any) => void> = [];
      const received: any[] = [];

      socket.on('data', (data) => {
        buffer += data.toString();
        let idx;
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (line) {
            const parsed = JSON.parse(line);
            if (pending.length > 0) {
              pending.shift()!(parsed);
            } else {
              received.push(parsed);
            }
          }
        }
      });

      resolve({
        socket,
        send: (msg: any) => socket.write(JSON.stringify(msg) + '\n'),
        receive: () => new Promise((res) => {
          if (received.length > 0) {
            res(received.shift());
          } else {
            pending.push(res);
          }
        }),
      });
    });
  });
}

describe('RpcServer', () => {
  let server: RpcServer;
  let socketPath: string;

  beforeEach(async () => {
    socketPath = nextSocket();
    server = new RpcServer({ socketPath });
  });

  afterEach(async () => {
    await server.close();
  });

  it('registers methods and dispatches calls', async () => {
    server.registerMethod('echo', async (params) => ({ echoed: params }));
    await server.listen();

    const client = await rawConnect(socketPath);
    client.send({ jsonrpc: '2.0', id: 1, method: 'echo', params: { hello: 'world' } });

    const resp = await client.receive();
    expect(resp.id).toBe(1);
    expect(resp.result).toEqual({ echoed: { hello: 'world' } });
    client.socket.destroy();
  });

  it('returns JSON-RPC error for unknown method', async () => {
    await server.listen();

    const client = await rawConnect(socketPath);
    client.send({ jsonrpc: '2.0', id: 1, method: 'nonexistent' });

    const resp = await client.receive();
    expect(resp.error).toBeDefined();
    expect(resp.error.code).toBe(-32601); // METHOD_NOT_FOUND
    client.socket.destroy();
  });

  it('handles malformed JSON gracefully', async () => {
    await server.listen();

    const client = await rawConnect(socketPath);
    client.socket.write('this is not json\n');

    const resp = await client.receive();
    expect(resp.error).toBeDefined();
    expect(resp.error.code).toBe(-32700); // PARSE_ERROR
    client.socket.destroy();
  });

  it('broadcasts notifications to all connected clients', async () => {
    await server.listen();

    const client1 = await rawConnect(socketPath);
    const client2 = await rawConnect(socketPath);
    // Wait for server to register both clients
    await new Promise((r) => setTimeout(r, 50));

    server.broadcastNotification('test.event', { data: 'hello' });

    const notif1 = await client1.receive();
    const notif2 = await client2.receive();

    expect(notif1.method).toBe('test.event');
    expect(notif1.params).toEqual({ data: 'hello' });
    expect(notif2.method).toBe('test.event');
    expect(notif2.params).toEqual({ data: 'hello' });

    client1.socket.destroy();
    client2.socket.destroy();
  });
});
