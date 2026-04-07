// tests/unit/mcp-servers/dispatch-control-rpc-server.test.ts
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import {
  handleStopExecution,
  handleSendToBackground,
  handleSwitchPermissionMode,
  handleSwitchModel,
  handleGetStatus,
  handleSwitchMode,
  createDispatchControlRpcServer,
} from '../../../src/mcp-servers/dispatch-control-rpc-server.js';

describe('dispatch-control-rpc-server handlers', () => {
  let mockRpcClient: any;

  beforeEach(() => {
    mockRpcClient = { call: jest.fn<() => Promise<unknown>>() };
  });

  // ── handleStopExecution ───────────────────────────────────────────

  describe('handleStopExecution', () => {
    it('calls worker.interrupt and returns success message', async () => {
      mockRpcClient.call.mockResolvedValue(undefined);
      const result = await handleStopExecution(mockRpcClient);
      expect(mockRpcClient.call).toHaveBeenCalledWith('worker.interrupt');
      expect(result).toContain('stopped');
    });

    it('returns error message when main worker is unreachable', async () => {
      mockRpcClient.call.mockRejectedValue(new Error('Connection refused'));
      const result = await handleStopExecution(mockRpcClient);
      expect(result.toLowerCase()).toContain('not reachable');
      expect(result).toContain('Connection refused');
    });
  });

  // ── handleSendToBackground ────────────────────────────────────────

  describe('handleSendToBackground', () => {
    it('calls worker.sendToBackground and returns success message', async () => {
      mockRpcClient.call.mockResolvedValue({ ok: true });
      const result = await handleSendToBackground(mockRpcClient);
      expect(mockRpcClient.call).toHaveBeenCalledWith('worker.sendToBackground');
      expect(result).toContain('background');
    });

    it('returns error message when main worker is unreachable', async () => {
      mockRpcClient.call.mockRejectedValue(new Error('ECONNREFUSED'));
      const result = await handleSendToBackground(mockRpcClient);
      expect(result.toLowerCase()).toContain('not reachable');
    });
  });

  // ── handleSwitchPermissionMode ────────────────────────────────────

  describe('handleSwitchPermissionMode', () => {
    it('calls worker.switchMode with the provided mode', async () => {
      mockRpcClient.call.mockResolvedValue({ ok: true });
      const result = await handleSwitchPermissionMode(mockRpcClient, { mode: 'acceptEdits' });
      expect(mockRpcClient.call).toHaveBeenCalledWith('worker.switchMode', { mode: 'acceptEdits' });
      expect(result).toContain('Accept Edits');
    });

    it('handles plan mode label', async () => {
      mockRpcClient.call.mockResolvedValue({ ok: true });
      const result = await handleSwitchPermissionMode(mockRpcClient, { mode: 'plan' });
      expect(result).toContain('Plan Only');
    });

    it('handles default mode label', async () => {
      mockRpcClient.call.mockResolvedValue({ ok: true });
      const result = await handleSwitchPermissionMode(mockRpcClient, { mode: 'default' });
      expect(result).toContain('Default');
    });

    it('returns error message when main worker is unreachable', async () => {
      mockRpcClient.call.mockRejectedValue(new Error('timeout'));
      const result = await handleSwitchPermissionMode(mockRpcClient, { mode: 'default' });
      expect(result.toLowerCase()).toContain('not reachable');
    });
  });

  // ── handleSwitchModel ─────────────────────────────────────────────

  describe('handleSwitchModel', () => {
    it('calls worker.switchModel and returns success message', async () => {
      mockRpcClient.call.mockResolvedValue({ ok: true });
      const result = await handleSwitchModel(mockRpcClient, { model: 'claude-haiku-4-5-20251001' });
      expect(mockRpcClient.call).toHaveBeenCalledWith('worker.switchModel', { model: 'claude-haiku-4-5-20251001' });
      expect(result).toContain('claude-haiku-4-5-20251001');
    });

    it('returns error message when main worker is unreachable', async () => {
      mockRpcClient.call.mockRejectedValue(new Error('Connection refused'));
      const result = await handleSwitchModel(mockRpcClient, { model: 'haiku' });
      expect(result.toLowerCase()).toContain('not reachable');
    });
  });

  // ── handleGetStatus ───────────────────────────────────────────────

  describe('handleGetStatus', () => {
    it('calls worker.getStatus and returns formatted JSON', async () => {
      mockRpcClient.call.mockResolvedValue({
        model: 'claude-sonnet-4-6',
        mode: 'default',
        hasActiveExecution: true,
        isBackground: false,
        effort: 'normal',
        budget: null,
        sessionId: 'sess-1',
      });
      const result = await handleGetStatus(mockRpcClient);
      expect(mockRpcClient.call).toHaveBeenCalledWith('worker.getStatus');
      expect(result).toContain('claude-sonnet-4-6');
      expect(result).toContain('sess-1');
      // Should be valid JSON
      expect(() => JSON.parse(result)).not.toThrow();
    });

    it('returns error message when main worker is unreachable', async () => {
      mockRpcClient.call.mockRejectedValue(new Error('Connection refused'));
      const result = await handleGetStatus(mockRpcClient);
      expect(result.toLowerCase()).toContain('not reachable');
      expect(result).toContain('Connection refused');
    });
  });

  // ── handleSwitchMode (alias) ──────────────────────────────────────

  describe('handleSwitchMode', () => {
    it('delegates to switch_permission_mode with same args', async () => {
      mockRpcClient.call.mockResolvedValue({ ok: true });
      const result = await handleSwitchMode(mockRpcClient, { mode: 'acceptEdits' });
      expect(mockRpcClient.call).toHaveBeenCalledWith('worker.switchMode', { mode: 'acceptEdits' });
      expect(result).toContain('Accept Edits');
    });
  });

  // ── createDispatchControlRpcServer ───────────────────────────────

  describe('createDispatchControlRpcServer', () => {
    it('returns an MCP server object', () => {
      const server = createDispatchControlRpcServer(mockRpcClient);
      expect(server).toBeDefined();
      expect(typeof server).toBe('object');
    });
  });
});
