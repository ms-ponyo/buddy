import { buildDispatchBlocks } from '../../../src/ui/dispatch-blocks.js';

const THREAD_KEY = 'C123:1111.2222';

describe('buildDispatchBlocks', () => {
  it('returns three blocks: section, input, actions', () => {
    const blocks = buildDispatchBlocks(THREAD_KEY);
    expect(blocks).toHaveLength(3);
    expect(blocks[0].type).toBe('section');
    expect(blocks[1].type).toBe('input');
    expect(blocks[2].type).toBe('actions');
  });

  it('shows default text when no response provided', () => {
    const blocks = buildDispatchBlocks(THREAD_KEY);
    const section = blocks[0] as any;
    expect(section.text.text).toContain('Dispatch session active');
  });

  it('shows responseText when provided', () => {
    const blocks = buildDispatchBlocks(THREAD_KEY, 'Hello from Haiku');
    const section = blocks[0] as any;
    expect(section.text.text).toContain('Hello from Haiku');
  });

  it('truncates responseText exceeding 3000 characters', () => {
    const longText = 'x'.repeat(3500);
    const blocks = buildDispatchBlocks(THREAD_KEY, longText);
    const section = blocks[0] as any;
    // The emoji prefix adds a few chars, but the core text is truncated to ~3000
    expect(section.text.text.length).toBeLessThanOrEqual(3010);
    expect(section.text.text.endsWith('…')).toBe(true);
  });

  it('input block has correct action_id and block_id', () => {
    const blocks = buildDispatchBlocks(THREAD_KEY);
    const input = blocks[1] as any;
    expect(input.element.action_id).toBe('haiku_reply');
    expect(input.block_id).toBe(`haiku_input:${THREAD_KEY}`);
  });

  it('input block has dispatch_action true so it submits on Enter', () => {
    const blocks = buildDispatchBlocks(THREAD_KEY);
    const input = blocks[1] as any;
    expect(input.dispatch_action).toBe(true);
  });

  it('actions block has Close button with action_id haiku_done and value=threadKey', () => {
    const blocks = buildDispatchBlocks(THREAD_KEY);
    const actions = blocks[2] as any;
    expect(actions.elements).toHaveLength(2);
    const closeBtn = actions.elements.find((e: any) => e.action_id === 'haiku_done');
    expect(closeBtn).toBeDefined();
    expect(closeBtn.value).toBe(THREAD_KEY);
    expect(closeBtn.text.text).toContain('Close');
  });
});
