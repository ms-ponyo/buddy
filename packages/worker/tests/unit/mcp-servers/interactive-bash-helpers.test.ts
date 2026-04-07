// tests/unit/mcp-servers/interactive-bash-helpers.test.ts
import { describe, it, expect } from '@jest/globals';
import { detectPrompt, stripAnsi } from '../../../src/mcp-servers/interactive-bash-helpers';

describe('stripAnsi', () => {
  it('strips CSI escape sequences', () => {
    expect(stripAnsi('\x1b[31mred text\x1b[0m')).toBe('red text');
  });

  it('strips OSC sequences', () => {
    expect(stripAnsi('\x1b]0;title\x07normal')).toBe('normal');
  });

  it('leaves plain text unchanged', () => {
    expect(stripAnsi('hello world')).toBe('hello world');
  });

  it('handles mixed content', () => {
    expect(stripAnsi('\x1b[1m\x1b[32m==> \x1b[0mDone')).toBe('==> Done');
  });
});

describe('detectPrompt', () => {
  // ── Password prompts ─────────────────────────────────────────

  it('detects password prompt', () => {
    const result = detectPrompt('Enter your credentials\nPassword: ');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('password');
  });

  it('detects passphrase prompt', () => {
    const result = detectPrompt('Enter passphrase for key: ');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('password');
  });

  // ── Yes/No prompts ───────────────────────────────────────────

  it('detects (y/n) prompt', () => {
    const result = detectPrompt('Do you want to continue? (y/n) ');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('yesno');
  });

  it('detects [Y/n] prompt', () => {
    const result = detectPrompt('Are you sure? [Y/n] ');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('yesno');
  });

  it('detects (yes/no) prompt', () => {
    const result = detectPrompt('Proceed? (yes/no) ');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('yesno');
  });

  it('detects "continue?" prompt', () => {
    const result = detectPrompt('Do you want to continue?');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('yesno');
  });

  // ── Press enter ──────────────────────────────────────────────

  it('detects press enter prompt', () => {
    const result = detectPrompt('Press Enter to continue...');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('press_enter');
  });

  it('detects press any key prompt', () => {
    const result = detectPrompt('Press any key to proceed');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('press_enter');
  });

  // ── Generic text prompts ─────────────────────────────────────

  it('detects prompt ending with ?', () => {
    const result = detectPrompt('What is your name?');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('text');
  });

  it('detects prompt ending with :', () => {
    const result = detectPrompt('Enter your email:');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('text');
  });

  it('detects prompt after output with newlines', () => {
    const result = detectPrompt('Some output\nMore output\nPaste the code here:');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('text');
    expect(result!.text).toBe('Paste the code here:');
  });

  // ── Non-prompts ──────────────────────────────────────────────

  it('returns null for empty string', () => {
    expect(detectPrompt('')).toBeNull();
  });

  it('returns null for regular output', () => {
    expect(detectPrompt('Building project...\nCompiling files\n')).toBeNull();
  });

  it('returns null for log lines with timestamps', () => {
    expect(detectPrompt('2024-01-15 12:34:56 INFO: Starting server')).toBeNull();
  });

  it('returns null for absolute paths ending with :', () => {
    expect(detectPrompt('/usr/local/bin/node:')).toBeNull();
  });

  it('returns null for very short last lines', () => {
    expect(detectPrompt('$')).toBeNull();
  });
});
