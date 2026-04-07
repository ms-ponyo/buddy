import { truncateStr, extractIntent, looksLikePlan, derivePlanTitle } from '../../../src/util/text-helpers';

describe('truncateStr', () => {
  it('returns unchanged string under limit', () => {
    expect(truncateStr('hello', 10)).toBe('hello');
  });

  it('truncates and adds suffix', () => {
    const result = truncateStr('hello world', 5);
    expect(result).toBe('hello\u2026 (truncated)');
  });

  it('handles exact length', () => {
    expect(truncateStr('hello', 5)).toBe('hello');
  });
});

describe('extractIntent', () => {
  it('returns empty for blank input', () => {
    expect(extractIntent('')).toBe('');
    expect(extractIntent('   ')).toBe('');
  });

  it('extracts intent from plain text', () => {
    expect(extractIntent('I will update the file')).toBe('I will update the file');
  });

  it('strips markdown prefixes', () => {
    expect(extractIntent('## Header\n- bullet')).toBe('Header\nbullet');
  });

  it('handles multi-line text', () => {
    const result = extractIntent('First line\n\nSecond line');
    expect(result).toContain('First line');
    expect(result).toContain('Second line');
  });
});

describe('looksLikePlan', () => {
  it('rejects short text', () => {
    expect(looksLikePlan('## Short')).toBe(false);
  });

  it('rejects long text without headers', () => {
    expect(looksLikePlan('x'.repeat(2000))).toBe(false);
  });

  it('accepts long text with markdown headers', () => {
    const plan = '## Step 1\n' + 'x'.repeat(1000) + '\n## Step 2\n' + 'y'.repeat(500);
    expect(looksLikePlan(plan)).toBe(true);
  });

  it('accepts ### headers', () => {
    const plan = '### Implementation\n' + 'details '.repeat(200);
    expect(looksLikePlan(plan)).toBe(true);
  });
});

describe('derivePlanTitle', () => {
  it('detects PR review pattern', () => {
    expect(derivePlanTitle('review PR #42', '')).toBe('Reviewing PR #42');
  });

  it('detects plan mode', () => {
    expect(derivePlanTitle('plan the migration', '')).toBe('Planning: the migration');
  });

  it('uses reasoning text when available', () => {
    const result = derivePlanTitle('do something', 'Analyzing the codebase structure');
    expect(result).toBe('Analyzing the codebase structure');
  });

  it('truncates long titles', () => {
    const long = 'x'.repeat(100);
    const result = derivePlanTitle(long, '');
    expect(result.length).toBeLessThanOrEqual(82); // 80 + ellipsis
  });

  it('falls back to user message', () => {
    const result = derivePlanTitle('simple message', '');
    expect(result).toBe('simple message');
  });
});
