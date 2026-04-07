// tests/unit/ui/reaction-manager.test.ts
import { jest } from '@jest/globals';
import {
  setReactions,
  swapReactions,
  addHourglass,
} from '../../../src/ui/reaction-manager.js';

function createMockAdapter() {
  return {
    addReaction: jest.fn<(ch: string, ts: string, emoji: string) => Promise<void>>().mockResolvedValue(undefined),
    removeReaction: jest.fn<(ch: string, ts: string, emoji: string) => Promise<void>>().mockResolvedValue(undefined),
  };
}

describe('setReactions', () => {
  it('removes old reaction and adds new for each timestamp', async () => {
    const adapter = createMockAdapter();
    await setReactions(adapter, 'C1', ['ts1', 'ts2'], 'white_check_mark', 'hourglass');

    expect(adapter.removeReaction).toHaveBeenCalledTimes(2);
    expect(adapter.removeReaction).toHaveBeenCalledWith('C1', 'ts1', 'hourglass');
    expect(adapter.removeReaction).toHaveBeenCalledWith('C1', 'ts2', 'hourglass');

    expect(adapter.addReaction).toHaveBeenCalledTimes(2);
    expect(adapter.addReaction).toHaveBeenCalledWith('C1', 'ts1', 'white_check_mark');
    expect(adapter.addReaction).toHaveBeenCalledWith('C1', 'ts2', 'white_check_mark');
  });

  it('ignores errors from removeReaction', async () => {
    const adapter = createMockAdapter();
    adapter.removeReaction.mockRejectedValue(new Error('not found'));
    await expect(setReactions(adapter, 'C1', ['ts1'], 'ok', 'old')).resolves.toBeUndefined();
    expect(adapter.addReaction).toHaveBeenCalledTimes(1);
  });

  it('ignores errors from addReaction', async () => {
    const adapter = createMockAdapter();
    adapter.addReaction.mockRejectedValue(new Error('already_reacted'));
    await expect(setReactions(adapter, 'C1', ['ts1'], 'ok', 'old')).resolves.toBeUndefined();
  });

  it('handles empty timestamps array', async () => {
    const adapter = createMockAdapter();
    await setReactions(adapter, 'C1', [], 'ok', 'old');
    expect(adapter.addReaction).not.toHaveBeenCalled();
    expect(adapter.removeReaction).not.toHaveBeenCalled();
  });
});

describe('swapReactions', () => {
  it('swaps hourglass_flowing_sand for the new reaction', async () => {
    const adapter = createMockAdapter();
    await swapReactions(adapter, 'C1', ['ts1'], 'white_check_mark');

    expect(adapter.removeReaction).toHaveBeenCalledWith('C1', 'ts1', 'hourglass_flowing_sand');
    expect(adapter.addReaction).toHaveBeenCalledWith('C1', 'ts1', 'white_check_mark');
  });
});

describe('addHourglass', () => {
  it('adds hourglass_flowing_sand reaction', async () => {
    const adapter = createMockAdapter();
    await addHourglass(adapter, 'C1', 'ts1');

    expect(adapter.addReaction).toHaveBeenCalledWith('C1', 'ts1', 'hourglass_flowing_sand');
  });

  it('ignores errors if reaction already exists', async () => {
    const adapter = createMockAdapter();
    adapter.addReaction.mockRejectedValue(new Error('already_reacted'));
    await expect(addHourglass(adapter, 'C1', 'ts1')).resolves.toBeUndefined();
  });
});
