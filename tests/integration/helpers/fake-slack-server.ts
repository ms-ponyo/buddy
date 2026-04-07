export interface RecordedCall {
  method: string;
  args: Record<string, unknown>;
  timestamp: number;
}

export interface FakeStreamerHandle {
  append: (payload: { chunks: unknown[] }) => Promise<{ ts?: string }>;
  stop: (finalPlan?: Record<string, unknown>) => Promise<void>;
}

export interface FakeSlackApp {
  client: {
    chat: {
      postMessage: (args: any) => Promise<{ ts: string }>;
      update: (args: any) => Promise<void>;
      delete: (args: any) => Promise<void>;
      postEphemeral: (args: any) => Promise<void>;
    };
    chatStream: (args: any) => FakeStreamerHandle;
    filesUploadV2: (args: any) => Promise<{ file: { id: string } }>;
    reactions: {
      add: (args: any) => Promise<void>;
      remove: (args: any) => Promise<void>;
    };
    views: {
      open: (args: any) => Promise<{ view: { id: string } }>;
      update: (args: any) => Promise<void>;
    };
    assistant: {
      threads: {
        setStatus: (args: any) => Promise<void>;
      };
    };
  };
  calls: RecordedCall[];
  getCalls: (method?: string) => RecordedCall[];
  reset: () => void;
}

export function createFakeSlackApp(): FakeSlackApp {
  const calls: RecordedCall[] = [];

  function record(method: string, args: any): void {
    calls.push({ method, args, timestamp: Date.now() });
  }

  const app: FakeSlackApp = {
    client: {
      chat: {
        postMessage: async (args: any) => {
          record('chat.postMessage', args);
          return { ts: `fake-${Date.now()}` };
        },
        update: async (args: any) => {
          record('chat.update', args);
        },
        delete: async (args: any) => {
          record('chat.delete', args);
        },
        postEphemeral: async (args: any) => {
          record('chat.postEphemeral', args);
        },
      },
      chatStream: (args: any) => {
        let streamCounter = 0;
        const streamTs = `stream-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        record('chatStream', args);
        return {
          append: async (payload: { chunks: unknown[] }) => {
            streamCounter++;
            record('chatStream.append', { streamTs, seq: streamCounter, ...payload });
            return { ts: streamTs };
          },
          stop: async (_finalPlan?: Record<string, unknown>) => {
            record('chatStream.stop', { streamTs });
          },
        };
      },
      filesUploadV2: async (args: any) => {
        record('filesUploadV2', args);
        return { file: { id: 'fake-file-id' } };
      },
      reactions: {
        add: async (args: any) => { record('reactions.add', args); },
        remove: async (args: any) => { record('reactions.remove', args); },
      },
      views: {
        open: async (args: any) => {
          record('views.open', args);
          return { view: { id: 'fake-view-id' } };
        },
        update: async (args: any) => { record('views.update', args); },
      },
      assistant: {
        threads: {
          setStatus: async (args: any) => { record('assistant.threads.setStatus', args); },
        },
      },
    },
    calls,
    getCalls: (method?: string) => method ? calls.filter((c) => c.method === method) : calls,
    reset: () => { calls.length = 0; },
  };

  return app;
}
