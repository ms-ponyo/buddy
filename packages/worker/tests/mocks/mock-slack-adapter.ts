// tests/mocks/mock-slack-adapter.ts — In-memory mock for SlackAdapter.

import { jest } from '@jest/globals';
import type { SlackMessage, SlackFileInfo } from '../../src/adapters/slack-adapter.js';

export interface PostedMessage {
  channel: string;
  threadTs: string;
  text: string;
  blocks?: unknown[];
}

export interface ReactionRecord {
  channel: string;
  ts: string;
  emoji: string;
  action: 'add' | 'remove';
}

export interface EphemeralRecord {
  channel: string;
  threadTs: string;
  user: string;
  text: string;
  blocks?: unknown[];
}

export interface UpdateRecord {
  channel: string;
  ts: string;
  text: string;
  blocks?: unknown[];
}

export interface UploadRecord {
  channel: string;
  threadTs: string;
  filename: string;
  filePath: string;
  caption?: string;
}

export interface InteractivePromptRecord {
  callbackId: string;
  promptType: 'permission' | 'question' | 'terminal' | 'planReview';
  display: unknown;
}

export interface MockSlackAdapter {
  // Tracking arrays
  posted: PostedMessage[];
  reactions: ReactionRecord[];
  ephemeral: EphemeralRecord[];
  updates: UpdateRecord[];
  uploads: UploadRecord[];
  interactivePrompts: InteractivePromptRecord[];

  // Outbound queue methods
  postMessage: jest.Mock<Promise<{ ts: string }>, [string, string, string, unknown[]?]>;
  uploadFile: jest.Mock<Promise<{ fileId: string }>, [string, string, string, string, string?]>;
  sendInteractivePrompt: jest.Mock<Promise<void>, [string, 'permission' | 'question' | 'terminal' | 'planReview', unknown]>;

  // Outbound queue methods (continued)
  appendToLastMessage: jest.Mock<Promise<void>, [string, string, string, unknown[]?]>;

  // Direct gateway methods
  deleteMessage: jest.Mock<Promise<void>, [string, string]>;
  apiCall: jest.Mock<Promise<any>, [string, Record<string, unknown>]>;
  updateMessage: jest.Mock<Promise<void>, [string, string, string, unknown[]?]>;
  postEphemeral: jest.Mock<Promise<void>, [string, string, string, string, unknown[]?]>;
  addReaction: jest.Mock<Promise<void>, [string, string, string]>;
  removeReaction: jest.Mock<Promise<void>, [string, string, string]>;
  setTypingStatus: jest.Mock<Promise<void>, [string, string, string]>;
  openView: jest.Mock<Promise<{ viewId: string }>, [string, unknown]>;
  updateView: jest.Mock<Promise<void>, [string, unknown]>;
  conversationsReplies: jest.Mock<Promise<{ messages?: SlackMessage[]; response_metadata?: { next_cursor?: string } }>, [any]>;
  conversationsHistory: jest.Mock<Promise<{ messages?: SlackMessage[] }>, [any]>;
  filesInfo: jest.Mock<Promise<{ file?: SlackFileInfo }>, [{ file: string }]>;
  enqueueOutbound: jest.Mock<Promise<void>, [unknown]>;

  // New direct/queue methods
  postMessageDirect: jest.Mock<Promise<{ ts: string }>, [string, string, string, unknown[]?]>;
  queueUpdateMessage: jest.Mock<Promise<void>, [string, string, string, unknown[]?]>;
  queueDeleteMessage: jest.Mock<Promise<void>, [string, string]>;

  // Worker state
  setWorkerState: jest.Mock<Promise<void>, [string]>;

  // Connection management
  connectGateway: jest.Mock<Promise<void>, []>;
  deregisterFromGateway: jest.Mock<Promise<void>, []>;
  close: jest.Mock<Promise<void>, []>;
  isGatewayConnected: jest.Mock<boolean, []>;
  isPersistenceConnected: jest.Mock<boolean, []>;
}

export function mockSlackAdapter(): MockSlackAdapter {
  const posted: PostedMessage[] = [];
  const reactions: ReactionRecord[] = [];
  const ephemeral: EphemeralRecord[] = [];
  const updates: UpdateRecord[] = [];
  const uploads: UploadRecord[] = [];
  const interactivePrompts: InteractivePromptRecord[] = [];

  const adapter: MockSlackAdapter = {
    posted,
    reactions,
    ephemeral,
    updates,
    uploads,
    interactivePrompts,

    postMessage: jest.fn(async (channel: string, threadTs: string, text: string, blocks?: unknown[]) => {
      posted.push({ channel, threadTs, text, blocks });
      return { ts: '' };
    }),

    uploadFile: jest.fn(async (channel: string, threadTs: string, filename: string, filePath: string, caption?: string) => {
      uploads.push({ channel, threadTs, filename, filePath, caption });
      return { fileId: '' };
    }),

    sendInteractivePrompt: jest.fn(async (callbackId: string, promptType: 'permission' | 'question' | 'terminal' | 'planReview', display: unknown) => {
      interactivePrompts.push({ callbackId, promptType, display });
    }),

    appendToLastMessage: jest.fn(async (_channel: string, _threadTs: string, _text: string, _blocks?: unknown[]) => {}),

    deleteMessage: jest.fn(async (_channel: string, _ts: string) => {}),

    apiCall: jest.fn(async (_method: string, _args: Record<string, unknown>) => {
      return undefined;
    }),

    updateMessage: jest.fn(async (channel: string, ts: string, text: string, blocks?: unknown[]) => {
      updates.push({ channel, ts, text, blocks });
    }),

    postEphemeral: jest.fn(async (channel: string, threadTs: string, user: string, text: string, blocks?: unknown[]) => {
      ephemeral.push({ channel, threadTs, user, text, blocks });
    }),

    addReaction: jest.fn(async (channel: string, ts: string, emoji: string) => {
      reactions.push({ channel, ts, emoji, action: 'add' });
    }),

    removeReaction: jest.fn(async (channel: string, ts: string, emoji: string) => {
      reactions.push({ channel, ts, emoji, action: 'remove' });
    }),

    setTypingStatus: jest.fn(async (_channel: string, _threadTs: string, _status: string) => {}),

    openView: jest.fn(async (_triggerId: string, _view: unknown) => ({ viewId: '' })),

    updateView: jest.fn(async (_viewId: string, _view: unknown) => {}),

    conversationsReplies: jest.fn(async (_args: any) => ({ messages: [] })),

    conversationsHistory: jest.fn(async (_args: any) => ({ messages: [] })),

    filesInfo: jest.fn(async (_args: { file: string }) => ({ file: undefined })),

    enqueueOutbound: jest.fn(async (_message: unknown) => {}),

    postMessageDirect: jest.fn(async (_channel: string, _threadTs: string, _text: string, _blocks?: unknown[]) => {
      return { ts: 'mock-direct-ts' };
    }),

    queueUpdateMessage: jest.fn(async (_channel: string, _ts: string, _text: string, _blocks?: unknown[]) => {}),

    queueDeleteMessage: jest.fn(async (_channel: string, _ts: string) => {}),

    setWorkerState: jest.fn(async (_state: string) => {}),

    connectGateway: jest.fn(async () => {}),
    deregisterFromGateway: jest.fn(async () => {}),
    close: jest.fn(async () => {}),
    isGatewayConnected: jest.fn(() => true),
    isPersistenceConnected: jest.fn(() => true),
  };

  return adapter;
}
