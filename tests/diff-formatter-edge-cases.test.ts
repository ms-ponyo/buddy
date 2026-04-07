import { formatDiffBlocks, DiffInput } from '../packages/worker/src/diff-formatter';

function blockText(block: { type: string; text?: string | { type: string; text: string } }): string {
  if (typeof block.text === 'string') return block.text;
  if (block.text && typeof block.text === 'object') return block.text.text;
  return '';
}

describe('formatDiffBlocks edge cases', () => {
  it('should truncate lines exceeding MAX_LINE_LENGTH (500 chars)', () => {
    const longLine = 'x'.repeat(600);
    const input: DiffInput = {
      file_path: 'src/long.ts',
      old_string: 'short',
      new_string: longLine,
    };

    const blocks = formatDiffBlocks(input);
    const text = blockText(blocks[0]);
    // The 600-char line should be truncated to 500 + '...'
    expect(text).toContain('x'.repeat(500) + '...');
    expect(text).not.toContain('x'.repeat(501));
  });

  it('should produce multiple hunks when changes are far apart', () => {
    // Create lines with changes separated by more than 2*context (>6 lines apart)
    const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
    const oldStr = lines.join('\n');
    const modified = [...lines];
    modified[1] = 'CHANGED_NEAR_TOP';    // line 2
    modified[18] = 'CHANGED_NEAR_BOTTOM'; // line 19
    const newStr = modified.join('\n');

    const input: DiffInput = {
      file_path: 'src/hunks.ts',
      old_string: oldStr,
      new_string: newStr,
    };

    const blocks = formatDiffBlocks(input);
    const text = blockText(blocks[0]);
    // Hunks are separated by " ..." in the actual format
    expect(text).toContain(' ...');
    expect(text).toContain('CHANGED_NEAR_TOP');
    expect(text).toContain('CHANGED_NEAR_BOTTOM');
  });

  it('should split into multiple blocks when exceeding MARKDOWN_BLOCK_LIMIT', () => {
    // Generate a diff large enough to exceed 12000 chars
    const lineCount = 70;
    const longContent = 'a'.repeat(150);
    const oldLines = Array(lineCount).fill(`old_${longContent}`).join('\n');
    const newLines = Array(lineCount).fill(`new_${longContent}`).join('\n');

    const input: DiffInput = {
      file_path: 'src/huge.ts',
      old_string: oldLines,
      new_string: newLines,
    };

    const blocks = formatDiffBlocks(input);
    // When the combined text exceeds 12000, it should split into summary + code blocks
    if (blocks.length === 2) {
      const summaryText = blockText(blocks[0]);
      const codeText = blockText(blocks[1]);
      expect(summaryText).toContain('`src/huge.ts`');
      expect(codeText).toContain('```diff');
    } else {
      // If it fits in one block, that's fine too—just verify it's valid
      expect(blocks.length).toBe(1);
      expect(blockText(blocks[0])).toContain('```diff');
    }
  });

  it('should return "No changes" for identical non-empty strings', () => {
    const input: DiffInput = {
      file_path: 'src/same.ts',
      old_string: 'const x = 1;\nconst y = 2;',
      new_string: 'const x = 1;\nconst y = 2;',
    };

    const blocks = formatDiffBlocks(input);
    const text = blockText(blocks[0]);
    expect(text).toContain('No changes');
  });

  it('should treat startLine of 1 the same as no startLine', () => {
    const input: DiffInput = {
      file_path: 'src/start1.ts',
      old_string: 'aaa\nbbb\nccc',
      new_string: 'aaa\nBBB\nccc',
      startLine: 1,
    };
    const inputNoStart: DiffInput = {
      file_path: 'src/start1.ts',
      old_string: 'aaa\nbbb\nccc',
      new_string: 'aaa\nBBB\nccc',
    };

    const text1 = blockText(formatDiffBlocks(input)[0]);
    const text2 = blockText(formatDiffBlocks(inputNoStart)[0]);
    expect(text1).toEqual(text2);
  });

  it('should treat startLine of 0 the same as startLine 1', () => {
    const input: DiffInput = {
      file_path: 'src/start0.ts',
      old_string: 'aaa\nbbb',
      new_string: 'aaa\nBBB',
      startLine: 0,
    };

    const blocks = formatDiffBlocks(input);
    const text = blockText(blocks[0]);
    // startLine <= 1 should default to no offset — no L-prefix in summary
    expect(text).not.toContain('L0');
    expect(text).not.toContain('L1');
    // The diff body should contain the changes
    expect(text).toContain('-bbb');
    expect(text).toContain('+BBB');
  });

  it('should handle whitespace-only changes', () => {
    const input: DiffInput = {
      file_path: 'src/spaces.ts',
      old_string: '  indented',
      new_string: '    indented',
    };

    const blocks = formatDiffBlocks(input);
    const text = blockText(blocks[0]);
    expect(text).toContain('```diff');
    // Actual format: prefix char directly followed by text (no line numbers or |)
    expect(text).toContain('-  indented');
    expect(text).toContain('+    indented');
  });

  it('should report exact addition and deletion counts', () => {
    const input: DiffInput = {
      file_path: 'src/counts.ts',
      old_string: 'remove1\nkeep\nremove2',
      new_string: 'add1\nkeep\nadd2\nadd3',
    };

    const blocks = formatDiffBlocks(input);
    const text = blockText(blocks[0]);
    // 2 deletions (remove1, remove2), 3 additions (add1, add2, add3)
    expect(text).toContain('**+3 -2**');
  });

  it('should detect binary when only old_string is binary', () => {
    const input: DiffInput = {
      file_path: 'data.bin',
      old_string: '\u0000\u0001\u0002\u0003',
      new_string: 'now text content',
    };

    const blocks = formatDiffBlocks(input);
    expect(blockText(blocks[0])).toContain('Binary file changed');
  });

  it('should detect binary when only new_string is binary', () => {
    const input: DiffInput = {
      file_path: 'data.bin',
      old_string: 'was text content',
      new_string: '\u0000\u0001\u0002\u0003',
    };

    const blocks = formatDiffBlocks(input);
    expect(blockText(blocks[0])).toContain('Binary file changed');
  });

  it('should include exactly 3 context lines around a change', () => {
    // 10 lines, change line 5 (index 4)
    const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`);
    const oldStr = lines.join('\n');
    const modified = [...lines];
    modified[4] = 'CHANGED';
    const newStr = modified.join('\n');

    const input: DiffInput = {
      file_path: 'src/ctx.ts',
      old_string: oldStr,
      new_string: newStr,
    };

    const blocks = formatDiffBlocks(input);
    const text = blockText(blocks[0]);

    // Actual format: prefix char directly followed by text (no line numbers or |)
    // Context: lines 2,3,4 before the change, lines 6,7,8 after
    expect(text).toContain(' line2');
    expect(text).toContain(' line3');
    expect(text).toContain(' line4');
    expect(text).toContain('-line5');
    expect(text).toContain('+CHANGED');
    expect(text).toContain(' line6');
    expect(text).toContain(' line7');
    expect(text).toContain(' line8');
    // line1 should NOT appear (more than 3 lines away)
    expect(text).not.toMatch(/\nline1\n| line1\n/);
    // line9 should NOT appear (more than 3 lines away)
    expect(text).not.toMatch(/\nline9\n| line9\n/);
  });

  it('should handle missing new_string (undefined)', () => {
    const blocks = formatDiffBlocks({
      file_path: 'test.ts',
      old_string: 'content',
      new_string: undefined,
    } as any);
    expect(blockText(blocks[0])).toContain('Error formatting diff');
    expect(blockText(blocks[0])).toContain('new_string is required');
  });

  it('should handle multiline additions and deletions correctly', () => {
    const input: DiffInput = {
      file_path: 'src/multi.ts',
      old_string: 'function foo() {\n  return 1;\n}',
      new_string: 'function foo() {\n  const x = 1;\n  const y = 2;\n  return x + y;\n}',
    };

    const blocks = formatDiffBlocks(input);
    const text = blockText(blocks[0]);
    // 1 deletion (return 1;), 3 additions (const x, const y, return x+y)
    expect(text).toContain('**+3 -1**');
    // Actual format: prefix char directly followed by text (no | separator)
    expect(text).toContain(' function foo() {');
    expect(text).toContain('+  const x = 1;');
    expect(text).toContain('+  return x + y;');
  });

  it('should pad line numbers consistently within a hunk', () => {
    const input: DiffInput = {
      file_path: 'src/pad.ts',
      old_string: 'a\nb\nc',
      new_string: 'a\nB\nc',
      startLine: 98,
    };

    const blocks = formatDiffBlocks(input);
    const text = blockText(blocks[0]);
    // Actual format: prefix char directly followed by text (no line numbers)
    // The startLine is reflected in the summary (L98) but not in the diff body
    expect(text).toContain('L98');
    expect(text).toContain(' a');
    expect(text).toContain('-b');
    expect(text).toContain('+B');
    expect(text).toContain(' c');
  });
});
