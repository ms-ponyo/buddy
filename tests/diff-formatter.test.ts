import { formatDiffBlocks, formatDiffMarkdown, DiffInput } from '../packages/worker/src/diff-formatter';

/** Helper to get the text from a markdown block */
function blockText(block: { type: string; text?: string | { type: string; text: string } }): string {
  if (typeof block.text === 'string') return block.text;
  if (block.text && typeof block.text === 'object') return block.text.text;
  return '';
}

describe('formatDiffBlocks', () => {
  it('should format simple modification as unified diff', () => {
    const input: DiffInput = {
      file_path: 'src/example.ts',
      old_string: 'const old = "value";',
      new_string: 'const updated = "value";'
    };

    const blocks = formatDiffBlocks(input);

    expect(blocks.length).toBeGreaterThanOrEqual(1);
    expect(blocks[0].type).toBe('markdown');
    const text = blockText(blocks[0]);
    expect(text).toContain('`src/example.ts`');
    expect(text).toContain('```diff');
    expect(text).toContain('-const old = "value";');
    expect(text).toContain('+const updated = "value";');
  });

  it('should handle pure addition (empty old_string)', () => {
    const input: DiffInput = {
      file_path: 'src/new-file.ts',
      old_string: '',
      new_string: 'const newFunction = () => {};'
    };

    const blocks = formatDiffBlocks(input);
    const text = blockText(blocks[0]);
    expect(text).toContain('`src/new-file.ts`');
    expect(text).toContain('+const newFunction = () => {};');
  });

  it('should handle pure deletion (empty new_string)', () => {
    const input: DiffInput = {
      file_path: 'src/deleted-file.ts',
      old_string: 'const deletedFunction = () => {};',
      new_string: ''
    };

    const blocks = formatDiffBlocks(input);
    const text = blockText(blocks[0]);
    expect(text).toContain('`src/deleted-file.ts`');
    expect(text).toContain('-const deletedFunction = () => {};');
  });

  it('should handle both empty strings', () => {
    const input: DiffInput = {
      file_path: 'src/empty.ts',
      old_string: '',
      new_string: ''
    };

    const blocks = formatDiffBlocks(input);
    const text = blockText(blocks[0]);
    expect(text).toContain('No changes');
  });

  it('should handle invalid input gracefully', () => {
    const blocks1 = formatDiffBlocks(null as any);
    expect(blocks1).toHaveLength(1);
    expect(blockText(blocks1[0])).toContain('Error formatting diff');
    expect(blockText(blocks1[0])).toContain('Input is required');

    const blocks2 = formatDiffBlocks({
      file_path: '',
      old_string: 'test',
      new_string: 'test2'
    } as any);
    expect(blockText(blocks2[0])).toContain('Error formatting diff');

    const blocks3 = formatDiffBlocks({
      file_path: 'test.ts',
      old_string: null,
      new_string: 'test'
    } as any);
    expect(blockText(blocks3[0])).toContain('Error formatting diff');
  });

  it('should show +N -N stats in summary', () => {
    const input: DiffInput = {
      file_path: 'src/stats.ts',
      old_string: 'line1\nline2\nline3',
      new_string: 'line1\nmodified\nline3\nline4'
    };

    const blocks = formatDiffBlocks(input);
    const text = blockText(blocks[0]);
    expect(text).toMatch(/\+\d+/);
    expect(text).toMatch(/-\d+/);
  });

  it('should handle multiline changes with context', () => {
    const input: DiffInput = {
      file_path: 'src/context.ts',
      old_string: 'line1\nline2\nline3\nline4\nline5',
      new_string: 'line1\nline2\nchanged\nline4\nline5'
    };

    const blocks = formatDiffBlocks(input);
    const text = blockText(blocks[0]);
    expect(text).toContain('```diff');
    expect(text).toContain('-line3');
    expect(text).toContain('+changed');
    // Context lines should be present (space-prefixed)
    expect(text).toContain(' line2');
    expect(text).toContain(' line4');
  });

  it('should handle binary file changes', () => {
    const input: DiffInput = {
      file_path: 'image.png',
      old_string: '\u0000\u0001\u0002',
      new_string: '\u0000\u0001\u0003'
    };

    const blocks = formatDiffBlocks(input);
    expect(blockText(blocks[0])).toContain('Binary file changed');
  });

  it('should truncate very large diffs', () => {
    const oldLines = Array(200).fill('old line').join('\n');
    const newLines = Array(200).fill('new line').join('\n');
    const input: DiffInput = {
      file_path: 'src/large.ts',
      old_string: oldLines,
      new_string: newLines
    };

    const blocks = formatDiffBlocks(input);
    const text = blockText(blocks[0]);
    expect(text).toContain('truncated');
  });

  it('should output only markdown blocks', () => {
    const input: DiffInput = {
      file_path: 'src/types.ts',
      old_string: 'type A = string;',
      new_string: 'type A = number;'
    };

    const blocks = formatDiffBlocks(input);
    for (const block of blocks) {
      expect(block.type).toBe('markdown');
    }
  });

  it('should show line reference in summary when startLine > 1', () => {
    const input: DiffInput = {
      file_path: 'src/app.ts',
      old_string: 'const a = 1;\nconst b = 2;\nconst c = 3;',
      new_string: 'const a = 1;\nconst b = 99;\nconst c = 3;',
      startLine: 50,
    };

    const blocks = formatDiffBlocks(input);
    const text = blockText(blocks[0]);
    expect(text).toContain('`src/app.ts` L50');
    expect(text).toContain('-const b = 2;');
    expect(text).toContain('+const b = 99;');
  });

  it('should not show line reference when starting at line 1', () => {
    const input: DiffInput = {
      file_path: 'src/app.ts',
      old_string: 'const a = 1;\nconst b = 2;\nconst c = 3;',
      new_string: 'const a = 1;\nconst b = 99;\nconst c = 3;',
    };

    const blocks = formatDiffBlocks(input);
    const text = blockText(blocks[0]);
    expect(text).toContain('`src/app.ts` —');
    expect(text).not.toContain('L1');
  });

  it('should not include --- +++ or @@ headers', () => {
    const input: DiffInput = {
      file_path: 'src/app.ts',
      old_string: 'const a = 1;',
      new_string: 'const a = 2;',
      startLine: 10,
    };

    const blocks = formatDiffBlocks(input);
    const text = blockText(blocks[0]);
    expect(text).not.toContain('--- a/');
    expect(text).not.toContain('+++ b/');
    expect(text).not.toContain('@@ ');
  });
});

describe("formatDiffMarkdown", () => {
  it("should return markdown string with diff code block", () => {
    const result = formatDiffMarkdown({
      file_path: "/src/config.ts",
      old_string: "const timeout = 5000;",
      new_string: "const timeout = 10000;",
    });
    expect(result).toContain("```diff");
    expect(result).toContain("`/src/config.ts`");
    expect(result).toContain("-const timeout = 5000;");
    expect(result).toContain("+const timeout = 10000;");
    expect(result).toContain("```");
  });

  it("should handle binary files", () => {
    const result = formatDiffMarkdown({
      file_path: "/img/logo.png",
      old_string: "\x00\x01\x02",
      new_string: "\x00\x01\x03",
    });
    expect(result).toContain("Binary file changed");
  });

  it("should return null for empty diff", () => {
    const result = formatDiffMarkdown({
      file_path: "/src/foo.ts",
      old_string: "",
      new_string: "",
    });
    expect(result).toBeNull();
  });
});
