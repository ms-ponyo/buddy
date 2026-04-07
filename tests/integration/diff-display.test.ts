import { formatDiffBlocks } from '../../packages/worker/src/util/diff-formatter.js';

function blockText(block: { type: string; text?: string | { type: string; text: string } }): string {
  if (typeof block.text === 'string') return block.text;
  if (block.text && typeof block.text === 'object') return block.text.text;
  return '';
}

describe('Diff Display Integration', () => {
  it('should handle real TypeScript file change (pure addition)', () => {
    const input = {
      file_path: 'src/components/Button.tsx',
      old_string: '',
      new_string: `interface Props {
  label: string;
  onClick?: () => void;
}

export const Button = ({ label, onClick }: Props) => {
  return <button onClick={onClick}>{label}</button>;
};`
    };

    const blocks = formatDiffBlocks(input);

    expect(blocks.length).toBeGreaterThanOrEqual(1);
    expect(blocks[0].type).toBe('markdown');
    const text = blockText(blocks[0]);
    expect(text).toContain('`src/components/Button.tsx`');
    expect(text).toContain('```diff');
    expect(text).toContain('+interface Props {');
    expect(text).toContain('+export const Button = ({ label, onClick }: Props) => {');
  });

  it('should handle multiple programming languages', () => {
    const pythonInput = {
      file_path: 'main.py',
      old_string: 'def hello():\n    print("Hello")',
      new_string: 'def hello(name):\n    print(f"Hello {name}")'
    };

    const blocks = formatDiffBlocks(pythonInput);

    const text = blockText(blocks[0]);
    expect(text).toContain('```diff');
    expect(text).toContain('-def hello():');
    expect(text).toContain('+def hello(name):');
  });

  it('should handle content modifications with unified diff format', () => {
    const input = {
      file_path: 'utils/helper.js',
      old_string: 'function calculate(a, b) {\n  return a + b;\n}',
      new_string: 'function calculate(a, b, c = 0) {\n  return a + b + c;\n}'
    };

    const blocks = formatDiffBlocks(input);

    const text = blockText(blocks[0]);
    expect(text).toContain('`utils/helper.js`');
    expect(text).toContain('```diff');
    expect(text).toContain('-function calculate(a, b) {');
    expect(text).toContain('+function calculate(a, b, c = 0) {');
    expect(text).toContain('+  return a + b + c;');
  });

  it('should handle pure deletions', () => {
    const input = {
      file_path: 'config/deprecated.yml',
      old_string: 'version: 1.0\ndebug: true\nlegacy: enabled',
      new_string: ''
    };

    const blocks = formatDiffBlocks(input);

    const text = blockText(blocks[0]);
    expect(text).toContain('`config/deprecated.yml`');
    expect(text).toContain('-version: 1.0');
    expect(text).toContain('-debug: true');
    expect(text).toContain('-legacy: enabled');
  });

  it('should handle binary files', () => {
    const input = {
      file_path: 'assets/logo.png',
      old_string: '\u0000PNG\u0001\u0002',
      new_string: '\u0000PNG\u0001\u0003'
    };

    const blocks = formatDiffBlocks(input);

    expect(blocks).toHaveLength(1);
    expect(blockText(blocks[0])).toContain('Binary file changed');
  });

  it('should handle empty diffs', () => {
    const input = {
      file_path: 'empty.txt',
      old_string: '',
      new_string: ''
    };

    const blocks = formatDiffBlocks(input);

    expect(blocks).toHaveLength(1);
    expect(blockText(blocks[0])).toContain('No changes');
  });

  it('should show line reference with startLine', () => {
    const input = {
      file_path: 'src/server.ts',
      old_string: 'app.listen(3000);',
      new_string: 'app.listen(8080);',
      startLine: 42,
    };

    const blocks = formatDiffBlocks(input);
    const text = blockText(blocks[0]);
    expect(text).toContain('`src/server.ts` L42');
    expect(text).toContain('-app.listen(3000);');
    expect(text).toContain('+app.listen(8080);');
    // No file-level unified diff headers (--- / +++ lines)
    expect(text).not.toContain('---');
    expect(text).not.toContain('+++');
    // Hunk headers (@@ lines) are included as part of the diff format
    expect(text).toContain('@@');
  });
});
