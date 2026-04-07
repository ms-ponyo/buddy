// @ts-nocheck
import { jest } from '@jest/globals';

const mockCreateSdkMcpServer = jest.fn((opts) => ({
  type: 'sdk',
  name: opts.name,
  instance: { tool: jest.fn() },
}));

const mockTool = jest.fn((name, description, schema, handler) => ({
  name,
  description,
  inputSchema: schema,
  handler,
}));

jest.unstable_mockModule('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: mockCreateSdkMcpServer,
  tool: mockTool,
}));

const { createSlackToolsServer } = await import('../packages/worker/src/mcp-servers/slack-tools-server');
const { createSdkMcpServer, tool } = await import('@anthropic-ai/claude-agent-sdk');

describe('createSlackToolsServer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns an MCP server config with expected shape', () => {
    const server = createSlackToolsServer({
      client: { files: {} } as any,
      channelId: 'C1234',
      threadTs: '1234.5678',
      token: 'xoxb-test',
      projectDir: '/tmp/project',
    });

    expect(server).toBeDefined();
    expect(typeof server).toBe('object');
  });

  it('calls createSdkMcpServer with name "slack-tools"', () => {
    createSlackToolsServer({
      client: { files: {} } as any,
      channelId: 'C1234',
      threadTs: '1234.5678',
      token: 'xoxb-test',
      projectDir: '/tmp/project',
    });

    expect(createSdkMcpServer).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'slack-tools' }),
    );
  });

  it('registers all slack tools', () => {
    createSlackToolsServer({
      client: { files: {} } as any,
      channelId: 'C1234',
      threadTs: '1234.5678',
      token: 'xoxb-test',
      projectDir: '/tmp/project',
    });

    expect(tool).toHaveBeenCalledTimes(5);
    for (const name of [
      'upload_file_to_slack',
      'download_slack_file',
      'fetch_thread_messages',
      'fetch_channel_messages',
      'fetch_message',
    ]) {
      expect(tool).toHaveBeenCalledWith(
        name,
        expect.any(String),
        expect.any(Object),
        expect.any(Function),
      );
    }
  });
});
