// src/mcp-servers/interactive-bash-helpers.ts — PTY factory and prompt detection
// for the interactive-bash MCP server.
//
// Spawns commands in a pseudo-terminal using node-pty, detects interactive
// prompts via idle-timeout heuristics, and fires callbacks.

import * as nodePty from 'node-pty';
import type { MenuOption } from '../ui/interactive-blocks.js';

// ── Types ─────────────────────────────────────────────────────────

export type PromptType = 'text' | 'yesno' | 'password' | 'press_enter' | 'menu';

export interface PromptInfo {
  type: PromptType;
  text: string;
  menuOptions?: MenuOption[];
}

export interface PtySession {
  sendInput(text: string): void;
  sendKey(key: string): void;
  kill(): void;
  readonly isAlive: boolean;
}

export interface PtyResult {
  exitCode: number;
  output: string;
  timedOut: boolean;
}

export type PtyFactory = (
  command: string,
  opts: {
    cwd?: string;
    onPrompt: (info: PromptInfo) => void;
    onOutput?: (chunk: string) => void;
    idleTimeoutMs?: number;
    totalTimeoutMs?: number;
  },
) => { session: PtySession; result: Promise<PtyResult> };

// ── ANSI stripping ────────────────────────────────────────────────

// Matches ANSI escape sequences: CSI, OSC (terminated by BEL or ST), and simple escapes.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\][^\x07]*\x07|\x1b\].*?\x1b\\|[\x1b\x9b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

// ── Prompt detection ──────────────────────────────────────────────

/** How long (ms) output must be idle before we check for a prompt. */
const PROMPT_IDLE_MS = 500;

/**
 * Inspect the trailing text of PTY output and classify the prompt type.
 * Returns null if the text doesn't look like a prompt waiting for input.
 */
export function detectPrompt(output: string): PromptInfo | null {
  // Get text after the last newline — the "current line" the user sees.
  const lastNewline = output.lastIndexOf('\n');
  const lastLine = (lastNewline >= 0 ? output.slice(lastNewline + 1) : output).trim();
  if (!lastLine || lastLine.length < 2) return null;

  // Password / passphrase
  if (/password\s*:/i.test(lastLine) || /passphrase/i.test(lastLine) || /secret\s*:/i.test(lastLine)) {
    return { type: 'password', text: lastLine };
  }

  // Yes / No
  if (
    /\(y\/n\)/i.test(lastLine) ||
    /\[y\/n\]/i.test(lastLine) ||
    /\(yes\/no\)/i.test(lastLine) ||
    /\[yes\/no\]/i.test(lastLine) ||
    /\bcontinue\s*\?\s*$/i.test(lastLine)
  ) {
    return { type: 'yesno', text: lastLine };
  }

  // Press enter / any key
  if (/press\s+(enter|return|any\s*key)/i.test(lastLine)) {
    return { type: 'press_enter', text: lastLine };
  }

  // Generic text prompt — ends with ?: or : (but not just a colon after a path)
  if (/[?]\s*$/.test(lastLine) || /:\s*$/.test(lastLine)) {
    // Avoid false positives on lines that are just paths or log output.
    // Heuristic: prompts are typically short-ish and don't start with common log prefixes.
    if (lastLine.length < 200 && !/^\[?\d{4}[-/]/.test(lastLine) && !/^\//.test(lastLine)) {
      return { type: 'text', text: lastLine };
    }
  }

  return null;
}

// ── Factory ───────────────────────────────────────────────────────

/** Default total timeout: 10 minutes (matches SDK Bash timeout ceiling). */
const DEFAULT_TOTAL_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Create a real PTY factory backed by node-pty.
 * Suitable for production use in the worker process.
 */
export function createPtyFactory(): PtyFactory {
  return (command, opts) => {
    const shell = process.env.SHELL || '/bin/bash';
    const ptyProcess = nodePty.spawn(shell, ['-l', '-c', command], {
      name: 'xterm-256color',
      cols: 200,
      rows: 50,
      cwd: opts.cwd ?? process.cwd(),
      env: process.env as Record<string, string>,
    });

    let rawOutput = '';
    let alive = true;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let totalTimer: ReturnType<typeof setTimeout> | null = null;
    // Track prompts we already fired so we don't re-fire for the same text.
    let lastPromptOffset = 0;

    const session: PtySession = {
      sendInput(text: string) {
        if (alive) ptyProcess.write(text);
      },
      sendKey(key: string) {
        if (!alive) return;
        const keyMap: Record<string, string> = {
          enter: '\r',
          down: '\x1b[B',
          up: '\x1b[A',
          tab: '\t',
        };
        ptyProcess.write(keyMap[key] ?? key);
      },
      kill() {
        if (alive) {
          alive = false;
          ptyProcess.kill();
        }
      },
      get isAlive() {
        return alive;
      },
    };

    const result = new Promise<PtyResult>((resolve) => {
      const cleanup = () => {
        if (idleTimer) clearTimeout(idleTimer);
        if (totalTimer) clearTimeout(totalTimer);
      };

      const totalTimeout = opts.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
      totalTimer = setTimeout(() => {
        if (!alive) return;
        alive = false;
        ptyProcess.kill();
        cleanup();
        resolve({ exitCode: -1, output: stripAnsi(rawOutput), timedOut: true });
      }, totalTimeout);

      ptyProcess.onData((data: string) => {
        rawOutput += data;
        const stripped = stripAnsi(data);
        opts.onOutput?.(stripped);

        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          if (!alive) return;
          const unchecked = stripAnsi(rawOutput.slice(lastPromptOffset));
          const promptInfo = detectPrompt(unchecked);
          if (promptInfo) {
            lastPromptOffset = rawOutput.length;
            opts.onPrompt(promptInfo);
          }
        }, opts.idleTimeoutMs ?? PROMPT_IDLE_MS);
      });

      ptyProcess.onExit(({ exitCode }) => {
        alive = false;
        cleanup();
        resolve({ exitCode, output: stripAnsi(rawOutput), timedOut: false });
      });
    });

    return { session, result };
  };
}
