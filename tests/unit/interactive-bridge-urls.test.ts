import { extractUrls, buildUrlBlock } from '../../packages/worker/src/ui/interactive-blocks.js';

describe('extractUrls', () => {
  it('extracts a single URL', () => {
    expect(extractUrls('Visit https://example.com to continue')).toEqual([
      'https://example.com',
    ]);
  });

  it('extracts multiple URLs', () => {
    const text = 'Go to https://a.com then https://b.com/path?q=1';
    expect(extractUrls(text)).toEqual([
      'https://a.com',
      'https://b.com/path?q=1',
    ]);
  });

  it('deduplicates URLs', () => {
    const text = 'https://dup.com and https://dup.com again';
    expect(extractUrls(text)).toEqual(['https://dup.com']);
  });

  it('strips trailing punctuation', () => {
    expect(extractUrls('Visit https://example.com.')).toEqual(['https://example.com']);
    expect(extractUrls('See https://example.com, then')).toEqual(['https://example.com']);
    expect(extractUrls('URL: https://example.com;')).toEqual(['https://example.com']);
  });

  it('handles auth flow URLs with query params', () => {
    const text = 'Open https://console.anthropic.com/setup-token?code=abc123&redirect=true in your browser';
    expect(extractUrls(text)).toEqual([
      'https://console.anthropic.com/setup-token?code=abc123&redirect=true',
    ]);
  });

  it('handles http URLs', () => {
    expect(extractUrls('Go to http://localhost:3000/callback')).toEqual([
      'http://localhost:3000/callback',
    ]);
  });

  it('returns empty array when no URLs', () => {
    expect(extractUrls('no urls here')).toEqual([]);
    expect(extractUrls('')).toEqual([]);
  });

  it('handles URLs in terminal output context', () => {
    const text = `To authenticate, visit:
  https://github.com/login/device
and enter code: ABCD-1234

Waiting for authentication...`;
    expect(extractUrls(text)).toEqual(['https://github.com/login/device']);
  });
});

describe('buildUrlBlock', () => {
  it('returns null when no URLs', () => {
    expect(buildUrlBlock('no urls here')).toBeNull();
  });

  it('builds a section block with a single clickable link', () => {
    const block = buildUrlBlock('Visit https://example.com');
    expect(block).toEqual({
      type: 'section',
      text: { type: 'mrkdwn', text: ':link: <https://example.com>' },
    });
  });

  it('builds a section block with multiple clickable links', () => {
    const block = buildUrlBlock('https://a.com and https://b.com');
    expect(block).toEqual({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: ':link: <https://a.com>\n:link: <https://b.com>',
      },
    });
  });
});
