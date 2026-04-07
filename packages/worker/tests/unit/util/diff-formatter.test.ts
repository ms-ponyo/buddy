import { formatDiffMarkdown, formatDiffBlocks } from '../../../src/util/diff-formatter';
import type { DiffInput } from '../../../src/util/diff-formatter';

describe('formatDiffMarkdown', () => {
  it('returns null for identical strings', () => {
    const input: DiffInput = { file_path: 'test.ts', old_string: 'hello', new_string: 'hello' };
    expect(formatDiffMarkdown(input)).toBeNull();
  });

  it('returns null for both empty strings', () => {
    const input: DiffInput = { file_path: 'test.ts', old_string: '', new_string: '' };
    expect(formatDiffMarkdown(input)).toBeNull();
  });

  it('returns null for missing file_path', () => {
    expect(formatDiffMarkdown({ file_path: '', old_string: 'a', new_string: 'b' })).toBeNull();
  });

  it('formats simple addition', () => {
    const input: DiffInput = { file_path: 'test.ts', old_string: 'line1\nline2', new_string: 'line1\nline2\nline3' };
    const result = formatDiffMarkdown(input);
    expect(result).not.toBeNull();
    expect(result).toContain('`test.ts`');
    expect(result).toContain('+1');
    expect(result).toContain('```diff');
    expect(result).toContain('+line3');
  });

  it('formats simple deletion', () => {
    const input: DiffInput = { file_path: 'test.ts', old_string: 'line1\nline2\nline3', new_string: 'line1\nline3' };
    const result = formatDiffMarkdown(input);
    expect(result).not.toBeNull();
    expect(result).toContain('-line2');
  });

  it('formats replacement', () => {
    const input: DiffInput = { file_path: 'test.ts', old_string: 'old line', new_string: 'new line' };
    const result = formatDiffMarkdown(input);
    expect(result).not.toBeNull();
    expect(result).toContain('-old line');
    expect(result).toContain('+new line');
  });

  it('shows line reference when startLine > 1', () => {
    const input: DiffInput = { file_path: 'test.ts', old_string: 'old', new_string: 'new', startLine: 42 };
    const result = formatDiffMarkdown(input);
    expect(result).toContain('L42');
  });

  it('handles binary content', () => {
    const binary = '\x00\x01\x02\x03binary content';
    const input: DiffInput = { file_path: 'img.png', old_string: binary, new_string: 'new' };
    const result = formatDiffMarkdown(input);
    expect(result).toContain('Binary file changed');
  });

  it('handles new file creation (empty old_string)', () => {
    const input: DiffInput = { file_path: 'new.ts', old_string: '', new_string: 'const x = 1;' };
    const result = formatDiffMarkdown(input);
    expect(result).not.toBeNull();
    expect(result).toContain('+const x = 1;');
  });
});

describe('formatDiffBlocks', () => {
  it('returns error block for missing file_path', () => {
    const result = formatDiffBlocks({ file_path: '', old_string: 'a', new_string: 'b' } as DiffInput);
    expect(result[0].text).toContain('Error formatting diff');
  });

  it('returns markdown block for valid diff', () => {
    const input: DiffInput = { file_path: 'test.ts', old_string: 'old', new_string: 'new' };
    const result = formatDiffBlocks(input);
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0].type).toBe('markdown');
  });

  it('returns no-changes block for identical content', () => {
    const input: DiffInput = { file_path: 'test.ts', old_string: 'same', new_string: 'same' };
    const result = formatDiffBlocks(input);
    expect(result[0].text).toContain('No changes');
  });

  it('returns no-changes block for both empty', () => {
    const input: DiffInput = { file_path: 'test.ts', old_string: '', new_string: '' };
    const result = formatDiffBlocks(input);
    expect(result[0].text).toContain('No changes');
  });

  it('returns binary block for binary content', () => {
    const binary = '\x00\x01\x02\x03binary';
    const input: DiffInput = { file_path: 'img.png', old_string: binary, new_string: 'text' };
    const result = formatDiffBlocks(input);
    expect(result[0].text).toContain('Binary file changed');
  });
});
