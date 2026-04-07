import { splitMarkdownIntoMessages, splitMessage, formatPlanAsMarkdownBlocks } from '../../../src/util/format';

describe('splitMessage', () => {
  it('returns single chunk for short text', () => {
    const result = splitMessage('Hello world');
    expect(result).toEqual(['Hello world']);
  });

  it('splits long text at paragraph boundary', () => {
    const para1 = 'a'.repeat(2500);
    const para2 = 'b'.repeat(1000);
    const text = para1 + '\n\n' + para2;
    const result = splitMessage(text);
    expect(result.length).toBe(2);
    expect(result[0]).toBe(para1);
    expect(result[1]).toBe(para2);
  });

  it('splits long text at newline when no paragraph break', () => {
    const line1 = 'a'.repeat(2500);
    const line2 = 'b'.repeat(1000);
    const text = line1 + '\n' + line2;
    const result = splitMessage(text);
    expect(result.length).toBe(2);
    expect(result[0]).toBe(line1);
    expect(result[1]).toBe(line2);
  });

  it('hard cuts when no good split point', () => {
    const text = 'x'.repeat(6000);
    const result = splitMessage(text);
    expect(result.length).toBe(2);
    expect(result[0].length).toBe(3000);
    expect(result[1].length).toBe(3000);
  });
});

describe('splitMarkdownIntoMessages', () => {
  it('returns single message for short text', () => {
    const result = splitMarkdownIntoMessages('Hello world');
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(1);
    expect(result[0][0]).toEqual({ type: 'markdown', text: 'Hello world' });
  });

  it('handles empty/whitespace input', () => {
    const result = splitMarkdownIntoMessages('  ');
    expect(result).toHaveLength(1);
    expect(result[0][0].type).toBe('markdown');
  });

  it('splits multiple tables into separate messages', () => {
    const table1 = '| A | B |\n| --- | --- |\n| 1 | 2 |';
    const table2 = '| C | D |\n| --- | --- |\n| 3 | 4 |';
    const text = table1 + '\n\nSome text\n\n' + table2;
    const result = splitMarkdownIntoMessages(text);
    // Should have at least 2 messages (one per table)
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  it('does not split tables inside code blocks', () => {
    const text = '```\n| not | a | table |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n```\n\nSome text\n\n| real | table |\n| --- | --- |\n| a | b |';
    const result = splitMarkdownIntoMessages(text);
    // The pipe lines inside code blocks should NOT be treated as tables
    // So there's only one table, meaning it should be a single message
    expect(result.length).toBe(1);
  });

  it('separates text after a table with a blank line', () => {
    const table = '| A | B |\n| --- | --- |\n| 1 | 2 |';
    const text = table + '\nSome text after the table';
    const result = splitMarkdownIntoMessages(text);
    // The text after the table should be separated by a blank line
    const fullText = result.map(msg => msg.map(b => b.text).join('')).join('');
    expect(fullText).toContain('| 1 | 2 |\n\nSome text after the table');
  });

  it('handles text with no tables as single message', () => {
    const text = '# Header\n\nSome paragraph\n\nAnother paragraph';
    const result = splitMarkdownIntoMessages(text);
    expect(result).toHaveLength(1);
  });

  it('splits before code block when split would fall inside it', () => {
    // Build text: some prose that fits, then a code block that would be split in the middle
    const prose = 'Some intro text.\n\n' + 'x'.repeat(10000);
    const codeBlock = '```ts\n' + 'const a = 1;\n'.repeat(500) + '```';
    const text = prose + '\n\n' + codeBlock;
    const result = splitMarkdownIntoMessages(text);
    // The code block should not be split — it should start a new message
    const allText = result.map(msg => msg.map(b => b.text).join('')).join('');
    // Every message that contains ``` should have matching pairs
    for (const msg of result) {
      const msgText = msg.map(b => b.text).join('');
      const fenceCount = (msgText.match(/^```/gm) || []).length;
      expect(fenceCount % 2).toBe(0);
    }
  });

  it('does regular split when code block itself exceeds max length', () => {
    // A code block so large it exceeds the max on its own
    const codeBlock = '```\n' + 'x'.repeat(15000) + '\n```';
    const result = splitMarkdownIntoMessages(codeBlock);
    // Should still produce output (not hang or error)
    expect(result.length).toBeGreaterThanOrEqual(1);
    const totalLen = result.reduce((sum, msg) => sum + msg.reduce((s, b) => s + b.text.length, 0), 0);
    expect(totalLen).toBeGreaterThan(0);
  });
});

describe('formatPlanAsMarkdownBlocks', () => {
  it('returns empty plan marker for empty input', () => {
    const result = formatPlanAsMarkdownBlocks('');
    expect(result).toEqual([{ type: 'markdown', text: '_Empty plan_' }]);
  });

  it('returns single block for short markdown', () => {
    const result = formatPlanAsMarkdownBlocks('## Plan\n\nDo the thing.');
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('markdown');
    expect(result[0].text).toContain('## Plan');
  });

  it('splits long markdown at paragraph boundaries', () => {
    const para = 'x'.repeat(10000);
    const text = para + '\n\n' + para;
    const result = formatPlanAsMarkdownBlocks(text);
    expect(result.length).toBeGreaterThanOrEqual(2);
    for (const block of result) {
      expect(block.type).toBe('markdown');
    }
  });
});
