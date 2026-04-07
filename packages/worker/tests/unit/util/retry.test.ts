import { jest } from '@jest/globals';
import { withRetry, isAuthError, isTransientError, BASE_DELAY_MS, MAX_DELAY_MS } from '../../../src/util/retry';
import { mockLogger } from '../../mocks/mock-logger';

describe('withRetry', () => {
  it('returns on first success', async () => {
    const fn = jest.fn<() => Promise<string>>().mockResolvedValue('ok');
    const result = await withRetry(fn, {}, mockLogger());
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on transient error', async () => {
    const fn = jest.fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValue('ok');
    const result = await withRetry(fn, { baseDelayMs: 1 }, mockLogger());
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries on API 500 server error', async () => {
    const err: any = new Error('Internal server error');
    err.status = 500;
    const fn = jest.fn<() => Promise<string>>()
      .mockRejectedValueOnce(err)
      .mockResolvedValue('ok');
    const result = await withRetry(fn, { baseDelayMs: 1 }, mockLogger());
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not retry auth errors', async () => {
    const fn = jest.fn<() => Promise<string>>().mockRejectedValue(new Error('does not have access'));
    await expect(withRetry(fn, { baseDelayMs: 1 }, mockLogger())).rejects.toThrow('does not have access');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not retry non-transient errors', async () => {
    const fn = jest.fn<() => Promise<string>>().mockRejectedValue(new Error('syntax error'));
    await expect(withRetry(fn, { baseDelayMs: 1 }, mockLogger())).rejects.toThrow('syntax error');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('respects maxRetries', async () => {
    const fn = jest.fn<() => Promise<string>>().mockRejectedValue(new Error('fetch failed'));
    await expect(withRetry(fn, { maxRetries: 2, baseDelayMs: 1 }, mockLogger())).rejects.toThrow('fetch failed');
    // attempt 0, 1, 2 = 3 calls (fails at attempt 2 which equals maxRetries)
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('calls onSleeping and onWaking callbacks', async () => {
    const onSleeping = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const onWaking = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const fn = jest.fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValue('ok');

    await withRetry(fn, { baseDelayMs: 1, onSleeping, onWaking }, mockLogger());
    expect(onSleeping).toHaveBeenCalledTimes(1);
    expect(onWaking).toHaveBeenCalledTimes(1);
  });

  it('logs retry attempts', async () => {
    const log = mockLogger();
    const fn = jest.fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValue('ok');

    await withRetry(fn, { baseDelayMs: 1 }, log);
    expect(log.calls.warn.length).toBeGreaterThan(0);
    expect(log.calls.warn[0].msg).toContain('Transient error');
  });
});

describe('isAuthError', () => {
  it('detects access denial', () => {
    expect(isAuthError(new Error('does not have access'))).toBe(true);
  });

  it('detects unauthorized', () => {
    expect(isAuthError(new Error('unauthorized'))).toBe(true);
  });

  it('detects forbidden', () => {
    expect(isAuthError(new Error('forbidden'))).toBe(true);
  });

  it('detects invalid api key', () => {
    expect(isAuthError(new Error('invalid api key'))).toBe(true);
  });

  it('rejects network error', () => {
    expect(isAuthError(new Error('network error'))).toBe(false);
  });

  it('handles null/undefined', () => {
    expect(isAuthError(null)).toBe(false);
    expect(isAuthError(undefined)).toBe(false);
  });
});

describe('isTransientError', () => {
  it('does not classify auth errors as transient', () => {
    // Auth errors should NOT be transient — they should not be retried
    expect(isTransientError(new Error('unauthorized'))).toBe(false);
    expect(isTransientError(new Error('does not have access'))).toBe(false);
    expect(isTransientError(new Error('forbidden'))).toBe(false);
  });

  it('detects fetch failures', () => {
    expect(isTransientError(new Error('fetch failed'))).toBe(true);
  });

  it('detects network errors by code', () => {
    const err: any = new Error('connection error');
    err.code = 'ECONNREFUSED';
    expect(isTransientError(err)).toBe(true);
  });

  it('detects API server errors by status code', () => {
    const err500: any = new Error('API Error');
    err500.status = 500;
    expect(isTransientError(err500)).toBe(true);

    const err502: any = new Error('API Error');
    err502.status = 502;
    expect(isTransientError(err502)).toBe(true);

    const err503: any = new Error('API Error');
    err503.status = 503;
    expect(isTransientError(err503)).toBe(true);

    const err529: any = new Error('API Error');
    err529.status = 529;
    expect(isTransientError(err529)).toBe(true);
  });

  it('detects rate limit errors by status code', () => {
    const err: any = new Error('Rate limited');
    err.status = 429;
    expect(isTransientError(err)).toBe(true);
  });

  it('does not retry 4xx client errors (except 429)', () => {
    const err400: any = new Error('Bad request');
    err400.status = 400;
    expect(isTransientError(err400)).toBe(false);

    const err404: any = new Error('Not found');
    err404.status = 404;
    expect(isTransientError(err404)).toBe(false);
  });

  it('detects server errors by message pattern', () => {
    expect(isTransientError(new Error('Internal server error'))).toBe(true);
    expect(isTransientError(new Error('bad gateway'))).toBe(true);
    expect(isTransientError(new Error('service unavailable'))).toBe(true);
    expect(isTransientError(new Error('overloaded'))).toBe(true);
    expect(isTransientError(new Error('too many requests'))).toBe(true);
  });

  it('detects the exact Anthropic 500 error format', () => {
    const err: any = new Error('API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}');
    err.status = 500;
    expect(isTransientError(err)).toBe(true);
  });

  it('rejects non-transient errors', () => {
    expect(isTransientError(new Error('syntax error'))).toBe(false);
  });

  it('handles null', () => {
    expect(isTransientError(null)).toBe(false);
  });
});

describe('constants', () => {
  it('exports expected delay values', () => {
    expect(BASE_DELAY_MS).toBe(3000);
    expect(MAX_DELAY_MS).toBe(60000);
  });
});
