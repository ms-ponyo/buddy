// src/mcp-servers/interactive-bash-server.ts — MCP server for running
// interactive bash commands through PTY.
//
// Session-based: the tool returns to the LLM when a prompt is detected
// (not only when the PTY exits). The LLM decides how to present output
// to the user and relays user input back via subsequent tool calls.
// No direct Slack messaging — all output flows through the SDK's normal
// message path (consistency queue).

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod/v4';
import type { Logger } from '../logger.js';
import { INTERACTIVE_USER_TIMEOUT_MS } from '../types.js';
import { createPtyFactory, type PromptInfo, type PtySession, type PtyFactory, type PtyResult } from './interactive-bash-helpers.js';

// ── Types ─────────────────────────────────────────────────────────

export interface InteractiveResult {
  status: 'prompt' | 'completed' | 'error';
  output: string;
  promptText?: string;
  promptType?: string;
  exitCode?: number;
  timedOut?: boolean;
}

export interface InteractiveBashServerDeps {
  logger: Logger;
}

// ── Session manager ───────────────────────────────────────────────

/**
 * Manages a single interactive PTY session.
 * Returns to the caller (LLM) on prompt detection or PTY exit.
 * One instance per worker thread.
 */
export class InteractiveBashSession {
  private readonly logger: Logger;
  private readonly ptyFactory: PtyFactory;

  private pty: PtySession | null = null;
  private outputBuffer = '';
  /** Resolve the current waiter (start or sendInput call). */
  private waiter: ((result: InteractiveResult) => void) | null = null;
  /** Result buffered when PTY exits/prompts while no waiter is active. */
  private buffered: InteractiveResult | null = null;
  private userTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: InteractiveBashServerDeps) {
    this.logger = deps.logger;
    this.ptyFactory = createPtyFactory();
  }

  // ── Public API ──────────────────────────────────────────────────

  /** Start a new interactive session. Kills any existing one. */
  start(command: string, timeoutMs?: number): Promise<InteractiveResult> {
    this.cleanup();

    this.outputBuffer = '';
    this.buffered = null;

    const { session, result } = this.ptyFactory(command, {
      onPrompt: (info: PromptInfo) => {
        this.clearUserTimeout();
        this.setUserTimeout();
        this.emit({
          status: 'prompt',
          output: this.drainOutput(),
          promptText: info.text,
          promptType: info.type,
        });
      },
      onOutput: (chunk: string) => {
        this.outputBuffer += chunk;
      },
      totalTimeoutMs: timeoutMs,
    });

    this.pty = session;

    result.then((r: PtyResult) => {
      this.pty = null;
      this.clearUserTimeout();
      this.emit({
        status: 'completed',
        output: this.drainOutput(),
        exitCode: r.exitCode,
        timedOut: r.timedOut,
      });
    });

    return this.wait();
  }

  /** Send input to the running PTY session. */
  sendInput(input: string): Promise<InteractiveResult> {
    this.clearUserTimeout();

    if (this.buffered) {
      const r = this.buffered;
      this.buffered = null;
      return Promise.resolve(r);
    }

    if (!this.pty?.isAlive) {
      return Promise.resolve({
        status: 'error',
        output: 'No active interactive session. Start one with the "command" parameter.',
      });
    }

    this.pty.sendInput(input + '\n');
    return this.wait();
  }

  /** Cancel the active session. */
  cancel(): InteractiveResult {
    const output = this.outputBuffer;
    this.cleanup();
    return { status: 'completed', output, exitCode: -1 };
  }

  /** True when a PTY session is alive. */
  get hasActiveSession(): boolean {
    return this.pty?.isAlive === true;
  }

  /** Clean up any active session. */
  cleanup(): void {
    this.clearUserTimeout();
    if (this.pty?.isAlive) this.pty.kill();
    this.pty = null;
    // If someone is waiting, resolve with error
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ status: 'error', output: this.outputBuffer + '\nSession cleaned up.' });
    }
    this.outputBuffer = '';
    this.buffered = null;
  }

  // ── Private helpers ─────────────────────────────────────────────

  /** Emit a result: resolve the waiter or buffer for the next call. */
  private emit(result: InteractiveResult): void {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(result);
    } else {
      this.buffered = result;
    }
  }

  /** Wait for the next result (prompt or exit). */
  private wait(): Promise<InteractiveResult> {
    if (this.buffered) {
      const r = this.buffered;
      this.buffered = null;
      return Promise.resolve(r);
    }
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }

  private drainOutput(): string {
    const out = this.outputBuffer;
    this.outputBuffer = '';
    return out;
  }

  private setUserTimeout(): void {
    this.userTimeout = setTimeout(() => {
      this.logger.warn('Interactive session timed out waiting for user input');
      if (this.pty?.isAlive) this.pty.kill();
      this.pty = null;
      this.emit({
        status: 'error',
        output: this.drainOutput() + '\nTimed out waiting for user input.',
      });
    }, INTERACTIVE_USER_TIMEOUT_MS);
  }

  private clearUserTimeout(): void {
    if (this.userTimeout) {
      clearTimeout(this.userTimeout);
      this.userTimeout = null;
    }
  }
}

// ── MCP server factory ────────────────────────────────────────────

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function formatResult(r: InteractiveResult): string {
  const parts: string[] = [];

  if (r.output.trim()) {
    parts.push(`Output:\n${trimOutput(r.output, 10000)}`);
  }

  switch (r.status) {
    case 'prompt':
      parts.push(`Prompt detected (${r.promptType ?? 'text'}): ${r.promptText}`);
      parts.push(
        'The session is waiting for user input. ' +
        'Show the relevant output to the user and ask them for the required input. ' +
        'Then call this tool again with the "input" parameter to continue the session.',
      );
      break;
    case 'completed':
      parts.push(`Session completed. Exit code: ${r.exitCode}${r.timedOut ? ' (timed out)' : ''}`);
      break;
    case 'error':
      parts.push(`Error: ${r.output}`);
      break;
  }

  return parts.join('\n\n');
}

function trimOutput(output: string, max: number): string {
  if (output.length <= max) return output;
  return '...' + output.slice(-max);
}

export function createInteractiveBashServer(session: InteractiveBashSession) {
  return createSdkMcpServer({
    name: 'interactive-bash',
    tools: [
      tool(
        'interactive_bash',
        `Run a bash command that requires interactive input (passwords, auth codes, y/n confirmations, menu selections, etc.).

This tool is SESSION-BASED for multi-step interactive commands:
1. First call: provide "command" to start the session. The tool returns when a prompt is detected or the command finishes.
2. When a prompt is detected: read the output, show relevant info to the user (URLs, instructions, etc.), and ask them for the required input.
3. After the user responds: call this tool again with "input" to send their response to the session.
4. Repeat steps 2-3 until the command completes.

Use this INSTEAD of the built-in Bash tool when:
- The command is known to ask for user input (read, auth flows, login scripts)
- A previous Bash attempt timed out waiting for input
- The command involves SSH, OAuth, or credential entry

Do NOT use this for non-interactive commands — use the regular Bash tool for those.`,
        {
          command: z.string().optional().describe(
            'Bash command to run. Starts a new interactive session (kills any existing one).',
          ),
          input: z.string().optional().describe(
            'Text input to send to the running interactive session.',
          ),
          cancel: z.boolean().optional().describe(
            'Cancel the current interactive session.',
          ),
          timeout_ms: z.number().optional().describe(
            'Maximum time in ms for the command (default: 10 minutes). Only used with "command".',
          ),
        },
        async (args) => {
          try {
            if (args.cancel) {
              return textResult(formatResult(session.cancel()));
            }
            if (args.command) {
              const result = await session.start(args.command, args.timeout_ms);
              return textResult(formatResult(result));
            }
            if (args.input !== undefined) {
              const result = await session.sendInput(args.input);
              return textResult(formatResult(result));
            }
            return textResult('Error: provide "command" to start, "input" to continue, or "cancel" to abort.');
          } catch (err) {
            return textResult(`Error: ${err instanceof Error ? err.message : String(err)}`);
          }
        },
      ),
    ],
  });
}
