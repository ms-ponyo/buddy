// src/util/retry.ts — transient-error retry logic.
// Ported from src/slack-handler/core/retry.ts.
// Key change: unlimited retries by default (Infinity), configurable via options.

/** Logger interface for dependency injection. */
interface Logger {
  warn(msg: string, ctx?: Record<string, unknown>): void;
}

// ── Transient error detection ────────────────────────────────────────

const TRANSIENT_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

export const BASE_DELAY_MS = 3_000;
export const MAX_DELAY_MS = 60_000; // cap at 1 minute between retries

export function isAuthError(error: unknown): boolean {
  if (error == null) return false;
  const msg = error instanceof Error ? error.message : String(error);
  return /does not have access|login again|unauthorized|forbidden|invalid.*api.key/i.test(msg);
}

export function isTransientError(error: unknown): boolean {
  if (error == null) return false;
  // Auth errors are NOT transient — they should not be retried
  if (isAuthError(error)) return false;
  const code = (error as { code?: string }).code;
  if (code && TRANSIENT_ERROR_CODES.has(code)) return true;
  // Check for HTTP status codes on the error object (Anthropic SDK style)
  const status = (error as { status?: number }).status;
  if (status && (status === 429 || status >= 500)) return true;
  const msg =
    error instanceof Error ? error.message : String(error);
  return /fetch failed|network|socket hang up|ECONNRE|overloaded|rate.limit|too many requests|internal server error|bad gateway|service unavailable|server error|status code (429|5\d{2})/i.test(msg);
}

// ── Retry wrapper ────────────────────────────────────────────────────

export interface RetryOptions {
  /** Max retry attempts. Default: Infinity (unlimited). */
  maxRetries?: number;
  /** Base delay in milliseconds for exponential backoff. Default: BASE_DELAY_MS (3000). */
  baseDelayMs?: number;
  /** Max delay in milliseconds. Default: MAX_DELAY_MS (60000). */
  maxDelayMs?: number;
  onSleeping?: () => Promise<void>;
  onWaking?: () => Promise<void>;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions | undefined,
  logger: Logger,
): Promise<T> {
  const maxRetries = opts?.maxRetries ?? Infinity;
  const baseDelay = opts?.baseDelayMs ?? BASE_DELAY_MS;
  const maxDelay = opts?.maxDelayMs ?? MAX_DELAY_MS;
  let sleeping = false;

  for (let attempt = 0; ; attempt++) {
    try {
      const result = await fn();
      if (sleeping && opts?.onWaking) {
        await opts.onWaking().catch(() => {});
      }
      return result;
    } catch (error) {
      if (!isTransientError(error) || attempt >= maxRetries) {
        if (sleeping && opts?.onWaking) {
          await opts.onWaking().catch(() => {});
        }
        throw error;
      }
      if (!sleeping && opts?.onSleeping) {
        await opts.onSleeping().catch(() => {});
        sleeping = true;
      }
      const delay = Math.min(baseDelay * 2 ** attempt, maxDelay);
      logger.warn("Transient error, retrying", {
        attempt: attempt + 1,
        delayMs: delay,
        error: error instanceof Error ? error.message : String(error),
      });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}
