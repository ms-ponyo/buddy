import { formatExecutionLog, getBriefToolInput, buildCompletionContextBlock } from '../../../src/util/execution-log';
import type { ExecEntry } from '../../../src/types';

describe('getBriefToolInput', () => {
  it('returns empty string when no matching entry', () => {
    expect(getBriefToolInput('Bash', [])).toBe('');
  });

  it('extracts file path from Read tool', () => {
    const entries: ExecEntry[] = [
      { type: 'tool_use', name: 'Read', input: { file_path: '/home/user/project/src/main.ts' }, id: 'tu1' },
    ];
    const result = getBriefToolInput('Read', entries);
    expect(result).toContain('src/main.ts');
  });

  it('extracts command from Bash tool', () => {
    const entries: ExecEntry[] = [
      { type: 'tool_use', name: 'Bash', input: { command: 'npm test' }, id: 'tu1' },
    ];
    const result = getBriefToolInput('Bash', entries);
    expect(result).toContain('npm test');
  });

  it('extracts pattern from Grep tool', () => {
    const entries: ExecEntry[] = [
      { type: 'tool_use', name: 'Grep', input: { pattern: 'TODO' }, id: 'tu1' },
    ];
    const result = getBriefToolInput('Grep', entries);
    expect(result).toContain('TODO');
  });

  it('matches by toolUseId when provided', () => {
    const entries: ExecEntry[] = [
      { type: 'tool_use', name: 'Read', input: { file_path: '/a/b.ts' }, id: 'tu1' },
      { type: 'tool_use', name: 'Read', input: { file_path: '/c/d.ts' }, id: 'tu2' },
    ];
    const result = getBriefToolInput('Read', entries, 'tu1');
    expect(result).toContain('a/b.ts');
  });
});

describe('buildCompletionContextBlock', () => {
  it('returns context block with mrkdwn', () => {
    const block = buildCompletionContextBlock('Usage: 1000 tokens');
    expect(block.type).toBe('context');
    expect((block.elements as any[])[0].text).toBe('Usage: 1000 tokens');
  });
});

describe('formatExecutionLog', () => {
  const usage = {
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 200,
    contextWindowPercent: 45,
    numTurns: 3,
  };

  it('formats basic log with header', () => {
    const entries: ExecEntry[] = [
      { type: 'text', content: 'I will help you.' },
    ];
    const result = formatExecutionLog(entries, 'Done!', usage, 'sess-123', 'claude-opus-4-6', 0.05);
    expect(result).toContain('# Execution Log');
    expect(result).toContain('sess-123');
    expect(result).toContain('claude-opus-4-6');
    expect(result).toContain('$0.0500');
    expect(result).toContain('45%');
    expect(result).toContain('I will help you.');
    expect(result).toContain('## Final Response');
    expect(result).toContain('Done!');
  });

  it('formats tool_use entries', () => {
    const entries: ExecEntry[] = [
      { type: 'tool_use', name: 'Bash', input: { command: 'ls' }, id: 'tu1' },
    ];
    const result = formatExecutionLog(entries, 'done', usage, 'sess', 'model', 0);
    expect(result).toContain('### Tool: Bash');
    expect(result).toContain('"command": "ls"');
  });

  it('formats tool_result entries', () => {
    const entries: ExecEntry[] = [
      { type: 'tool_result', name: 'Bash', id: 'tu1', result: 'file1.ts\nfile2.ts' },
    ];
    const result = formatExecutionLog(entries, 'done', usage, 'sess', 'model', 0);
    expect(result).toContain('**Result:**');
    expect(result).toContain('file1.ts');
  });

  it('formats status_change entries', () => {
    const entries: ExecEntry[] = [
      { type: 'status_change', message: 'compacting context' },
    ];
    const result = formatExecutionLog(entries, 'done', usage, 'sess', 'model', 0);
    expect(result).toContain('compacting context');
  });

  it('formats user_message entries', () => {
    const entries: ExecEntry[] = [
      { type: 'user_message', content: 'fix the bug' },
    ];
    const result = formatExecutionLog(entries, 'done', usage, 'sess', 'model', 0);
    expect(result).toContain('## User');
    expect(result).toContain('fix the bug');
  });

  it('shows N/A for zero context window percent', () => {
    const zeroUsage = { ...usage, contextWindowPercent: 0 };
    const result = formatExecutionLog([], 'done', zeroUsage, 'sess', 'model', 0);
    expect(result).toContain('N/A');
  });
});
