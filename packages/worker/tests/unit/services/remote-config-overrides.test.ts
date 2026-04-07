import { jest } from '@jest/globals';
import { RemoteConfigOverrides } from '../../../src/services/remote-config-overrides.js';

describe('RemoteConfigOverrides', () => {
  let mockRpcClient: any;
  let remote: RemoteConfigOverrides;

  beforeEach(() => {
    mockRpcClient = {
      call: jest.fn<() => Promise<unknown>>(),
    };
    remote = new RemoteConfigOverrides(mockRpcClient);
  });

  it('fetches status on refresh and caches', async () => {
    mockRpcClient.call.mockResolvedValue({
      model: 'sonnet', mode: 'default', effort: 'normal', budget: null,
      isBackground: false, hasActiveExecution: false, sessionId: null,
    });
    await remote.refresh();
    expect(remote.getModel()).toBe('sonnet');
    expect(remote.getPermissionMode()).toBe('default');
    expect(mockRpcClient.call).toHaveBeenCalledTimes(1);
    // Second read uses cache
    remote.getModel();
    expect(mockRpcClient.call).toHaveBeenCalledTimes(1);
  });

  it('setModel calls RPC and invalidates cache', async () => {
    mockRpcClient.call.mockResolvedValue({ ok: true });
    await remote.setModel('haiku');
    expect(mockRpcClient.call).toHaveBeenCalledWith('worker.switchModel', { model: 'haiku' });
  });

  it('setPermissionMode calls RPC', async () => {
    mockRpcClient.call.mockResolvedValue({ ok: true });
    await remote.setPermissionMode('trust');
    expect(mockRpcClient.call).toHaveBeenCalledWith('worker.switchMode', { mode: 'trust' });
  });

  it('setEffort calls RPC', async () => {
    mockRpcClient.call.mockResolvedValue({ ok: true });
    await remote.setEffort('high');
    expect(mockRpcClient.call).toHaveBeenCalledWith('worker.switchEffort', { effort: 'high' });
  });

  it('setBudget calls RPC', async () => {
    mockRpcClient.call.mockResolvedValue({ ok: true });
    await remote.setBudget(100);
    expect(mockRpcClient.call).toHaveBeenCalledWith('worker.switchBudget', { budget: 100 });
  });

  it('returns fallback values when main worker is unreachable', async () => {
    mockRpcClient.call.mockRejectedValue(new Error('Connection refused'));
    await remote.refresh();
    expect(remote.getModel()).toBe('unknown');
    expect(remote.getPermissionMode()).toBe('unknown');
  });
});
