// tests/unit/ui/interactive-blocks.test.ts
import {
  truncateCommand,
  escapeSlackText,
  extractUrls,
  buildUrlBlock,
  buildInteractiveHeaderBlocks,
  buildInteractivePromptBlocks,
  buildInteractiveStreamBlocks,
  buildInteractiveCompletedBlocks,
  buildInteractiveFailedBlocks,
} from '../../../src/ui/interactive-blocks.js';

describe('truncateCommand', () => {
  it('returns short commands unchanged', () => {
    expect(truncateCommand('ls -la')).toBe('ls -la');
  });

  it('truncates commands longer than 80 chars', () => {
    const long = 'a'.repeat(100);
    const result = truncateCommand(long);
    expect(result.length).toBe(80);
    expect(result).toBe('a'.repeat(77) + '...');
  });
});

describe('escapeSlackText', () => {
  it('escapes ampersands, angle brackets', () => {
    expect(escapeSlackText('a & b')).toBe('a &amp; b');
    expect(escapeSlackText('<script>')).toBe('&lt;script&gt;');
  });

  it('returns plain text unchanged', () => {
    expect(escapeSlackText('hello world')).toBe('hello world');
  });
});

describe('extractUrls', () => {
  it('extracts URLs from text', () => {
    const text = 'Visit https://example.com and http://test.org/path for more.';
    const urls = extractUrls(text);
    expect(urls).toContain('https://example.com');
    expect(urls).toContain('http://test.org/path');
  });

  it('deduplicates URLs', () => {
    const text = 'https://example.com foo https://example.com';
    expect(extractUrls(text)).toEqual(['https://example.com']);
  });

  it('strips trailing punctuation', () => {
    const text = 'See https://example.com.';
    const urls = extractUrls(text);
    expect(urls).toEqual(['https://example.com']);
  });

  it('returns empty array when no URLs', () => {
    expect(extractUrls('no urls here')).toEqual([]);
  });
});

describe('buildUrlBlock', () => {
  it('returns a section block with clickable links', () => {
    const block = buildUrlBlock('Check https://example.com');
    expect(block).not.toBeNull();
    expect(JSON.stringify(block)).toContain(':link:');
    expect(JSON.stringify(block)).toContain('<https://example.com>');
  });

  it('returns null when no URLs found', () => {
    expect(buildUrlBlock('no urls')).toBeNull();
  });
});

describe('buildInteractiveHeaderBlocks', () => {
  it('builds header and cancel button for initial state', () => {
    const blocks = buildInteractiveHeaderBlocks({
      command: 'npm install',
      requestId: 'int-001',
    });

    const blocksJson = JSON.stringify(blocks);
    expect(blocksJson).toContain(':computer:');
    expect(blocksJson).toContain('npm install');
    expect(blocksJson).toContain('interactive_cancel');
    expect(blocksJson).toContain('int-001');
    expect(blocksJson).toContain('Starting...');
  });

  it('includes hint text when provided', () => {
    const blocks = buildInteractiveHeaderBlocks({
      command: 'gh auth login',
      requestId: 'int-002',
      hint: 'Follow the prompts',
    });

    const blocksJson = JSON.stringify(blocks);
    expect(blocksJson).toContain('Follow the prompts');
  });
});

describe('buildInteractivePromptBlocks', () => {
  it('builds blocks for yesno prompt', () => {
    const blocks = buildInteractivePromptBlocks({
      command: 'npm install',
      requestId: 'int-010',
      promptType: 'yesno',
      promptText: 'Continue with installation?',
      outputContext: '',
    });

    const blocksJson = JSON.stringify(blocks);
    expect(blocksJson).toContain('interactive_yes');
    expect(blocksJson).toContain('interactive_no');
    expect(blocksJson).toContain('interactive_cancel');
    expect(blocksJson).toContain('Continue with installation?');
  });

  it('builds blocks for press_enter prompt', () => {
    const blocks = buildInteractivePromptBlocks({
      command: 'something',
      requestId: 'int-011',
      promptType: 'press_enter',
      promptText: 'Press Enter to continue',
      outputContext: '',
    });

    const blocksJson = JSON.stringify(blocks);
    expect(blocksJson).toContain('interactive_enter');
    expect(blocksJson).toContain('Press Enter');
  });

  it('builds blocks for password prompt', () => {
    const blocks = buildInteractivePromptBlocks({
      command: 'ssh login',
      requestId: 'int-012',
      promptType: 'password',
      promptText: 'Enter password',
      outputContext: '',
    });

    const blocksJson = JSON.stringify(blocks);
    expect(blocksJson).toContain(':lock:');
    expect(blocksJson).toContain('interactive_password');
  });

  it('builds blocks for menu prompt', () => {
    const blocks = buildInteractivePromptBlocks({
      command: 'select',
      requestId: 'int-013',
      promptType: 'menu',
      promptText: 'Choose an option',
      outputContext: '',
      menuOptions: [
        { index: 0, label: 'First', isSelected: false },
        { index: 1, label: 'Second', isSelected: true },
      ],
    });

    const blocksJson = JSON.stringify(blocks);
    expect(blocksJson).toContain('interactive_menu_0');
    expect(blocksJson).toContain('interactive_menu_1');
    expect(blocksJson).toContain('First');
    expect(blocksJson).toContain('Second');
  });

  it('builds blocks for generic text input prompt', () => {
    const blocks = buildInteractivePromptBlocks({
      command: 'input needed',
      requestId: 'int-014',
      promptType: 'text',
      promptText: 'Enter value',
      outputContext: '',
    });

    const blocksJson = JSON.stringify(blocks);
    expect(blocksJson).toContain('interactive_text_input');
    expect(blocksJson).toContain('Enter value');
  });

  it('includes output context when provided', () => {
    const blocks = buildInteractivePromptBlocks({
      command: 'some-cmd',
      requestId: 'int-015',
      promptType: 'yesno',
      promptText: 'Confirm?',
      outputContext: 'Some output from the command',
    });

    const blocksJson = JSON.stringify(blocks);
    expect(blocksJson).toContain('Some output from the command');
  });
});

describe('buildInteractiveStreamBlocks', () => {
  it('builds blocks showing streaming output with cancel button', () => {
    const blocks = buildInteractiveStreamBlocks({
      command: 'long-running',
      requestId: 'int-020',
      displayOutput: 'partial output here',
    });

    const blocksJson = JSON.stringify(blocks);
    expect(blocksJson).toContain(':computer:');
    expect(blocksJson).toContain('long-running');
    expect(blocksJson).toContain('partial output here');
    expect(blocksJson).toContain('interactive_cancel');
  });
});

describe('buildInteractiveCompletedBlocks', () => {
  it('builds blocks for successful completion', () => {
    const blocks = buildInteractiveCompletedBlocks({
      command: 'npm test',
      exitCode: 0,
      timedOut: false,
      displayOutput: 'All tests passed',
    });

    const blocksJson = JSON.stringify(blocks);
    expect(blocksJson).toContain(':white_check_mark:');
    expect(blocksJson).toContain('npm test');
    expect(blocksJson).toContain('Exit code: 0');
    expect(blocksJson).toContain('All tests passed');
  });

  it('builds blocks for failed completion', () => {
    const blocks = buildInteractiveCompletedBlocks({
      command: 'npm test',
      exitCode: 1,
      timedOut: false,
      displayOutput: 'Tests failed',
    });

    const blocksJson = JSON.stringify(blocks);
    expect(blocksJson).toContain(':x:');
  });

  it('indicates timeout', () => {
    const blocks = buildInteractiveCompletedBlocks({
      command: 'slow-cmd',
      exitCode: 1,
      timedOut: true,
    });

    const blocksJson = JSON.stringify(blocks);
    expect(blocksJson).toContain('Timed out');
  });
});

describe('buildInteractiveFailedBlocks', () => {
  it('builds error blocks', () => {
    const blocks = buildInteractiveFailedBlocks({
      command: 'bad-cmd',
      error: 'spawn ENOENT',
    });

    const blocksJson = JSON.stringify(blocks);
    expect(blocksJson).toContain(':x:');
    expect(blocksJson).toContain('bad-cmd');
    expect(blocksJson).toContain('spawn ENOENT');
  });
});
