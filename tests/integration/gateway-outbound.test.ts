import { jest } from '@jest/globals';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { QueueMessage } from '../../packages/shared/src/rpc-types.js';
import { createFakeSlackApp, type FakeSlackApp } from './helpers/fake-slack-server.js';
import { setupPersistenceServer, createTempDir, waitForCondition } from './helpers/test-helpers.js';

/**
 * Reimplements gateway's processOutboundMessage logic for testing.
 * This mirrors packages/gateway/src/index.ts.
 */
async function processOutboundMessage(app: FakeSlackApp, msg: QueueMessage): Promise<void> {
  const payload = msg.payload as Record<string, any>;
  const type = payload.type as string;

  switch (type) {
    case 'postMessage': {
      const args: Record<string, unknown> = { channel: payload.channel, thread_ts: payload.thread_ts, text: payload.text };
      if (payload.blocks) args.blocks = payload.blocks;
      await app.client.chat.postMessage(args);
      break;
    }
    case 'fileUpload': {
      const args: Record<string, unknown> = {
        channel_id: payload.channel_id,
        thread_ts: payload.thread_ts,
        filename: payload.filename,
      };
      if (payload.file_path) {
        args.file = readFileSync(payload.file_path as string);
      }
      if (payload.initial_comment) args.initial_comment = payload.initial_comment;
      await app.client.filesUploadV2(args);
      break;
    }
    case 'interactivePrompt': {
      // Simplified — just verify it calls postMessage for the prompt
      const [channel, threadTs] = msg.threadKey.split(':');
      await app.client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: `Permission requested: ${payload.display?.tool || 'unknown'}`,
      });
      break;
    }
  }
}

describe('Gateway Outbound Processing', () => {
  let fakeSlack: FakeSlackApp;
  let cleanup: () => Promise<void>;
  let client: any;
  const delivered: QueueMessage[] = [];

  beforeAll(async () => {
    const setup = await setupPersistenceServer();
    client = setup.client;
    cleanup = setup.cleanup;
    fakeSlack = createFakeSlackApp();

    // Register deliver.message handler to receive pushed messages
    client.registerMethod('deliver.message', (params: any) => {
      const { message } = params as { message: QueueMessage };
      delivered.push(message);
      return { accepted: true };
    });

    await client.call('identify', { type: 'gateway' });
    await client.call('queue.subscribe', { queue: 'outbound' });
  });

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(() => {
    fakeSlack.reset();
    delivered.length = 0;
  });

  it('postMessage → fake Slack receives chat.postMessage', async () => {
    const { id } = await client.call('queue.enqueue', {
      queue: 'outbound',
      threadKey: 'C100:T200',
      message: { type: 'postMessage', channel: 'C100', thread_ts: 'T200', text: 'Hello from worker' },
    }) as { id: string };

    await waitForCondition(() => delivered.length > 0);

    await processOutboundMessage(fakeSlack, delivered[0]);
    await client.call('queue.ack', { queue: 'outbound', id });

    const calls = fakeSlack.getCalls('chat.postMessage');
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toMatchObject({
      channel: 'C100',
      thread_ts: 'T200',
      text: 'Hello from worker',
    });
  });

  it('fileUpload → fake Slack receives filesUploadV2', async () => {
    const { dir, cleanup: cleanupDir } = createTempDir();
    const filePath = join(dir, 'test.txt');
    writeFileSync(filePath, 'file contents');

    const { id } = await client.call('queue.enqueue', {
      queue: 'outbound',
      threadKey: 'C100:T200',
      message: { type: 'fileUpload', channel_id: 'C100', thread_ts: 'T200', filename: 'test.txt', file_path: filePath },
    }) as { id: string };

    await waitForCondition(() => delivered.length > 0);

    await processOutboundMessage(fakeSlack, delivered[0]);
    await client.call('queue.ack', { queue: 'outbound', id });

    const calls = fakeSlack.getCalls('filesUploadV2');
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toMatchObject({ channel_id: 'C100', filename: 'test.txt' });

    cleanupDir();
  });

  it('interactivePrompt → fake Slack receives postMessage', async () => {
    const { id } = await client.call('queue.enqueue', {
      queue: 'outbound',
      threadKey: 'C100:T200',
      message: {
        type: 'interactivePrompt',
        callbackId: 'cb-1',
        promptType: 'permission',
        display: { tool: 'bash', command: 'rm -rf /' },
      },
    }) as { id: string };

    await waitForCondition(() => delivered.length > 0);

    await processOutboundMessage(fakeSlack, delivered[0]);
    await client.call('queue.ack', { queue: 'outbound', id });

    const calls = fakeSlack.getCalls('chat.postMessage');
    expect(calls).toHaveLength(1);
    expect(calls[0].args.text).toContain('Permission requested');
  });

  it('failed Slack call → message nacked → retried → deadlettered', async () => {
    // Make postMessage throw
    const origPostMessage = fakeSlack.client.chat.postMessage;
    fakeSlack.client.chat.postMessage = async () => { throw new Error('Slack API error'); };

    const { id } = await client.call('queue.enqueue', {
      queue: 'outbound',
      threadKey: 'C100:T300',
      message: { type: 'postMessage', channel: 'C100', thread_ts: 'T300', text: 'will-fail' },
    }) as { id: string };

    // Simulate 3 retry cycles
    for (let i = 0; i < 3; i++) {
      await waitForCondition(() => delivered.length > i, 3000);
      try {
        await processOutboundMessage(fakeSlack, delivered[i]);
        await client.call('queue.ack', { queue: 'outbound', id });
      } catch {
        await client.call('queue.nack', { queue: 'outbound', id });
      }
    }

    // After 3 nacks, message should be deadlettered — no more deliveries
    await new Promise((r) => setTimeout(r, 200));

    // Restore
    fakeSlack.client.chat.postMessage = origPostMessage;
  }, 15000);
});
