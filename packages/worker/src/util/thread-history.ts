// src/util/thread-history.ts — fetch and format Slack thread history.
// Ported from src/slack-handler/util/thread-history.ts.
// Key change: functions accept a slack adapter parameter instead of importing a global.

import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Logger interface for dependency injection. */
interface Logger {
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
}

/** Minimal Slack adapter interface for thread history operations. */
export interface ThreadHistorySlack {
  conversationsReplies(args: {
    channel: string;
    ts: string;
    limit: number;
    cursor?: string;
  }): Promise<{
    messages?: Array<{
      user?: string;
      bot_id?: string;
      text?: string;
      ts: string;
    }>;
    response_metadata?: { next_cursor?: string };
  }>;
}

/** Max characters per individual message before truncating */
const MSG_CHAR_LIMIT = 2_000;

const HISTORY_DIR = join(process.cwd(), "data", "thread-history");

interface ThreadMessage {
  user: string;
  text: string;
  ts: string;
  isBot: boolean;
}

/**
 * Fetch messages from a Slack thread and format them as a text block.
 * Does NOT write to file — returns the formatted text and message count.
 *
 * This is the core fetch+format logic used by both `fetchThreadHistory`
 * (session recovery) and the fork-thread tool.
 */
export async function fetchAndFormatThreadHistory(
  slack: ThreadHistorySlack,
  channel: string,
  threadTs: string,
  log: Logger,
): Promise<{ formatted: string; messageCount: number; messages: ThreadMessage[] } | null> {
  const messages: ThreadMessage[] = [];
  let cursor: string | undefined;

  do {
    const result = await slack.conversationsReplies({
      channel,
      ts: threadTs,
      limit: 200,
      ...(cursor ? { cursor } : {}),
    });
    for (const msg of result.messages ?? []) {
      if (!msg.text) continue;
      messages.push({
        user: msg.bot_id ? "assistant" : (msg.user ?? "unknown"),
        text: msg.text,
        ts: msg.ts,
        isBot: !!msg.bot_id,
      });
    }
    cursor = result.response_metadata?.next_cursor;
  } while (cursor);

  if (messages.length === 0) return null;

  log.info("Fetched thread history", { messageCount: messages.length });

  const formatted = messages
    .map((m) => {
      const prefix = m.isBot ? "[assistant]" : `<@${m.user}>`;
      const text = m.text.length > MSG_CHAR_LIMIT
        ? m.text.slice(0, MSG_CHAR_LIMIT) + `\n[...truncated \u2014 use fetch_message with ts="${m.ts}" to read full text]`
        : m.text;
      return `[ts=${m.ts}] ${prefix}: ${text}`;
    })
    .join("\n\n");

  return { formatted, messageCount: messages.length, messages };
}

/**
 * Fetch messages from a Slack thread and format them as conversation context.
 * Includes both user and bot messages for full context.
 *
 * Always writes to a file and returns a short prompt referencing it,
 * so the model can Read selectively without burning context window.
 */
export async function fetchThreadHistory(
  slack: ThreadHistorySlack,
  channel: string,
  threadTs: string,
  log: Logger,
): Promise<string | null> {
  const result = await fetchAndFormatThreadHistory(slack, channel, threadTs, log);
  if (!result) return null;

  const { formatted, messageCount, messages } = result;

  // Always write to file — let the model Read selectively
  mkdirSync(HISTORY_DIR, { recursive: true });
  const filename = `${channel}_${threadTs}.txt`;
  const filePath = join(HISTORY_DIR, filename);
  writeFileSync(filePath, formatted);
  log.info("Thread history written to file", { filePath, chars: formatted.length, messages: messageCount });

  const preview = buildSummaryHint(messages);

  return `[Previous conversation from this Slack thread \u2014 your session was reset]\n`
    + `Full thread history (${messageCount} messages) saved to: ${filePath}\n`
    + `Read this file for context before responding.\n`
    + preview;
}

/** Build a brief hint showing the first and last few exchanges */
function buildSummaryHint(messages: ThreadMessage[]): string {
  if (messages.length <= 6) {
    // Short enough to preview all messages
    const lines = messages.map((m) => {
      const prefix = m.isBot ? "[assistant]" : `<@${m.user}>`;
      const text = m.text.length > 200 ? m.text.slice(0, 200) + "..." : m.text;
      return `${prefix}: ${text}`;
    });
    return "\nThread preview:\n" + lines.join("\n");
  }

  const first3 = messages.slice(0, 3);
  const last3 = messages.slice(-3);
  const parts = [
    ...first3.map((m) => {
      const prefix = m.isBot ? "[assistant]" : `<@${m.user}>`;
      const text = m.text.length > 200 ? m.text.slice(0, 200) + "..." : m.text;
      return `${prefix}: ${text}`;
    }),
    `... ${messages.length - 6} more messages ...`,
    ...last3.map((m) => {
      const prefix = m.isBot ? "[assistant]" : `<@${m.user}>`;
      const text = m.text.length > 200 ? m.text.slice(0, 200) + "..." : m.text;
      return `${prefix}: ${text}`;
    }),
  ];
  return "\nThread preview:\n" + parts.join("\n");
}

// ── Fork helpers ──────────────────────────────────────────────────────

const FORK_PREFIX = "fork_";
const FORK_META_SEPARATOR = "\n---FORK_META---\n";

export interface ForkLogPaths {
  mainLog?: string;
  sessionLog?: string;
  execLog?: string;
}

/**
 * Save pre-fetched thread history to a file with a `fork_` prefix.
 * Used by the fork-thread tool to stash source-thread context for the
 * new thread's opus worker to pick up.
 *
 * Optionally includes log file paths from the source thread as metadata.
 *
 * @returns The absolute file path where the history was saved.
 */
export function saveForkedHistory(
  channel: string,
  threadTs: string,
  historyText: string,
  logPaths?: ForkLogPaths,
): string {
  mkdirSync(HISTORY_DIR, { recursive: true });
  const filename = `${FORK_PREFIX}${channel}_${threadTs}.txt`;
  const filePath = join(HISTORY_DIR, filename);

  let content = historyText;
  if (logPaths) {
    content += FORK_META_SEPARATOR + JSON.stringify(logPaths);
  }

  writeFileSync(filePath, content);
  return filePath;
}

/**
 * Check for a fork history file for the given thread.
 * Returns the file content, path, and any log file paths if found.
 *
 * Does NOT delete the file — the model needs to Read it via the file path.
 */
export function consumeForkedHistory(
  channel: string,
  threadTs: string,
): { content: string; filePath: string; logPaths?: ForkLogPaths } | null {
  const filename = `${FORK_PREFIX}${channel}_${threadTs}.txt`;
  const filePath = join(HISTORY_DIR, filename);
  if (!existsSync(filePath)) return null;

  const raw = readFileSync(filePath, "utf-8");
  const sepIdx = raw.indexOf(FORK_META_SEPARATOR);
  if (sepIdx === -1) {
    return { content: raw, filePath };
  }

  const content = raw.slice(0, sepIdx);
  let logPaths: ForkLogPaths | undefined;
  try {
    logPaths = JSON.parse(raw.slice(sepIdx + FORK_META_SEPARATOR.length));
  } catch { /* ignore parse errors */ }

  return { content, filePath, logPaths };
}

/**
 * Get a Slack permalink URL for a specific message.
 * Uses the `chat.getPermalink` Slack API method via the adapter.
 */
export async function getThreadPermalink(
  slack: { apiCall(method: string, args: Record<string, unknown>): Promise<any> },
  channel: string,
  messageTs: string,
): Promise<string | null> {
  try {
    const result = await slack.apiCall('chat.getPermalink', {
      channel,
      message_ts: messageTs,
    });
    return result?.permalink ?? null;
  } catch {
    return null;
  }
}
