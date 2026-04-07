// src/services/interactive-bridge.ts — Owns interactive PTY sessions.
// Combines command classification, session lifecycle, output streaming to Slack,
// and user interaction handling (buttons, text input, menu selection).
//
// Ported from:
//   src/interactive-bridge.ts (PTY management, command classification)
//   src/slack-handler/hooks/interactive-bridge.ts (Slack integration, prompt handling)

import type { Logger } from '../logger.js';
import type { SlackAdapter } from '../adapters/slack-adapter.js';
import type { BridgeResult } from '../types.js';
import {
  INTERACTIVE_USER_TIMEOUT_MS,
  INTERACTIVE_OUTPUT_THROTTLE_MS,
} from '../types.js';
import {
  buildInteractiveHeaderBlocks,
  buildInteractivePromptBlocks,
  buildInteractiveStreamBlocks,
  buildInteractiveCompletedBlocks,
  buildInteractiveFailedBlocks,
  type MenuOption,
} from '../ui/interactive-blocks.js';

// ── Types ─────────────────────────────────────────────────────────

export type PromptType = 'text' | 'yesno' | 'password' | 'press_enter' | 'menu';

export interface PromptInfo {
  type: PromptType;
  text: string;
  menuOptions?: MenuOption[];
}

/** Payload shape for resolveInteraction. */
export interface InteractionPayload {
  action: 'text' | 'yes' | 'no' | 'enter' | 'cancel' | 'menu' | 'password';
  text?: string;
  menuIndex?: number;
}

/** An abstract PTY session (injectable for testing). */
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

/** Factory function to create a PTY session. Can be overridden for testing. */
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

// ── Internal pending session ──────────────────────────────────────

interface PendingSession {
  callbackId: string;
  command: string;
  channel: string;
  threadTs: string;
  resolve: (result: BridgeResult) => void;
  messageTs?: string;
  outputSoFar: string;
  lastOutputUpdate: number;
  userInputTimeout?: ReturnType<typeof setTimeout>;
  ptySession?: PtySession;
}

// ── Command parsing helper ────────────────────────────────────────

function parseCommand(command: string): { base: string; args: string }[] {
  const segments = command.split(/\s*(?:&&|\|\||[;|])\s*/);
  const results: { base: string; args: string }[] = [];

  for (const segment of segments) {
    const parts = segment.trim().split(/\s+/);
    let i = 0;
    // Skip env var assignments
    while (i < parts.length && /^[A-Za-z_]\w*=/.test(parts[i])) i++;
    const rawBase = parts[i];
    if (!rawBase) continue;
    // Strip directory prefix so "/usr/bin/python" matches "python"
    const base = rawBase.includes('/') ? rawBase.split('/').pop()! : rawBase;
    results.push({ base, args: parts.slice(i + 1).join(' ') });
  }

  return results;
}

// ── Constructor deps ──────────────────────────────────────────────

export interface InteractiveBridgeDeps {
  slack: SlackAdapter;
  logger: Logger;
  /** Optional PTY factory override for testing. When null, sessions work
   *  without real PTY (stub mode for unit tests). */
  ptyFactory?: PtyFactory;
}

// ── InteractiveBridge ─────────────────────────────────────────────

export class InteractiveBridge {
  private readonly slack: SlackAdapter;
  private readonly logger: Logger;
  private readonly ptyFactory: PtyFactory | undefined;

  private pendingSession: PendingSession | null = null;

  constructor(deps: InteractiveBridgeDeps) {
    this.slack = deps.slack;
    this.logger = deps.logger;
    this.ptyFactory = deps.ptyFactory;
  }

  // ── isInteractiveCommand ──────────────────────────────────────

  /**
   * Check if a Bash command matches any of the given interactive patterns.
   * Each pattern can be:
   *   - A simple base command name (e.g., "ssh", "telnet")
   *   - A multi-word pattern (e.g., "gh auth login") where the first word
   *     is the base command and the rest must match the start of the args.
   */
  isInteractiveCommand(command: string, patterns: string[]): boolean {
    if (patterns.length === 0) return false;

    const parsed = parseCommand(command);

    for (const { base, args } of parsed) {
      for (const pattern of patterns) {
        const patternParts = pattern.trim().split(/\s+/);
        const patternBase = patternParts[0];
        const patternArgs = patternParts.slice(1).join(' ');

        if (base === patternBase) {
          if (!patternArgs) {
            // Simple base match (e.g., "ssh")
            return true;
          }
          // Multi-word pattern: check if args start with the pattern args
          if (args.startsWith(patternArgs)) {
            return true;
          }
        }
      }
    }

    return false;
  }

  // ── startSession ──────────────────────────────────────────────

  /**
   * Start an interactive session for a command.
   * Posts an interactive header message to Slack and returns a promise
   * that resolves when the user interacts or a timeout occurs.
   */
  startSession(
    toolUseId: string,
    command: string,
    channel: string,
    threadTs: string,
    hint?: string,
  ): Promise<BridgeResult> {
    // Supersede any existing pending session
    if (this.pendingSession) {
      this.cancelPending('Superseded by new interactive session');
    }

    const threadKey = `${channel}:${threadTs}`;
    const requestId = toolUseId;

    // Post initial interactive header blocks
    const headerBlocks = buildInteractiveHeaderBlocks({
      command,
      requestId,
      hint,
    });

    this.slack.postMessage(
      channel,
      threadTs,
      `Interactive: ${command}`,
      headerBlocks,
    ).then(({ ts }) => {
      if (this.pendingSession?.callbackId === requestId) {
        this.pendingSession.messageTs = ts;
      }
    }).catch((err) => {
      this.logger.warn('Failed to post interactive bridge message', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    this.logger.info('Interactive session started', { command, requestId });

    return new Promise<BridgeResult>((resolve) => {
      const pending: PendingSession = {
        callbackId: requestId,
        command,
        channel,
        threadTs,
        resolve,
        outputSoFar: '',
        lastOutputUpdate: 0,
      };

      // Set up user input timeout
      pending.userInputTimeout = setTimeout(() => {
        if (this.pendingSession?.callbackId !== requestId) return;
        this.logger.warn('Interactive session timed out waiting for user input', { command });

        // Kill any active PTY session
        if (pending.ptySession?.isAlive) {
          pending.ptySession.kill();
        }

        this.pendingSession = null;
        resolve({
          handled: true,
          error: 'Timed out waiting for user input',
        });
      }, INTERACTIVE_USER_TIMEOUT_MS);

      // If a PTY factory is provided, spawn the command
      if (this.ptyFactory) {
        this.spawnPtySession(pending, requestId, threadKey);
      }

      this.pendingSession = pending;
    });
  }

  // ── resolveInteraction ────────────────────────────────────────

  /**
   * Resolve the pending interactive session.
   * Returns true if a matching callbackId was found and resolved, false otherwise.
   */
  resolveInteraction(callbackId: string, payload: InteractionPayload): boolean {
    if (!this.pendingSession || this.pendingSession.callbackId !== callbackId) {
      this.logger.warn('resolveInteraction: no matching callbackId', { callbackId });
      return false;
    }

    const pending = this.pendingSession;
    this.pendingSession = null;

    // Clear the user input timeout
    if (pending.userInputTimeout) {
      clearTimeout(pending.userInputTimeout);
    }

    // Kill any active PTY session
    if (pending.ptySession?.isAlive) {
      pending.ptySession.kill();
    }

    this.logger.info('Interactive session resolved', {
      callbackId,
      action: payload.action,
    });

    // Build the result
    switch (payload.action) {
      case 'cancel':
        pending.resolve({
          handled: true,
          output: pending.outputSoFar || undefined,
          error: 'Cancelled by user',
        });
        break;

      case 'text':
        // Send text to PTY if alive, otherwise just resolve with it
        if (pending.ptySession?.isAlive) {
          pending.ptySession.sendInput((payload.text ?? '') + '\n');
        }
        pending.resolve({
          handled: true,
          output: `User input: ${payload.text ?? ''}`,
        });
        break;

      case 'yes':
        if (pending.ptySession?.isAlive) {
          pending.ptySession.sendInput('y\n');
        }
        pending.resolve({
          handled: true,
          output: 'User input: yes',
        });
        break;

      case 'no':
        if (pending.ptySession?.isAlive) {
          pending.ptySession.sendInput('n\n');
        }
        pending.resolve({
          handled: true,
          output: 'User input: no',
        });
        break;

      case 'enter':
        if (pending.ptySession?.isAlive) {
          pending.ptySession.sendKey('enter');
        }
        pending.resolve({
          handled: true,
          output: 'User pressed Enter',
        });
        break;

      case 'menu':
        if (pending.ptySession?.isAlive && payload.menuIndex !== undefined) {
          // Navigate to the menu item and select it
          for (let i = 0; i < payload.menuIndex; i++) {
            pending.ptySession.sendKey('down');
          }
          pending.ptySession.sendKey('enter');
        }
        pending.resolve({
          handled: true,
          output: `User selected menu item ${payload.menuIndex ?? 0}`,
        });
        break;

      case 'password':
        if (pending.ptySession?.isAlive) {
          pending.ptySession.sendInput((payload.text ?? '') + '\n');
        }
        pending.resolve({
          handled: true,
          output: 'User entered password',
        });
        break;

      default:
        pending.resolve({
          handled: true,
          output: pending.outputSoFar || undefined,
        });
        break;
    }

    // Update the Slack message to show completion
    this.updateCompletedMessage(pending, payload);

    return true;
  }

  // ── hasPending ────────────────────────────────────────────────

  /**
   * True when an interactive session is active and awaiting user input.
   */
  get hasPending(): boolean {
    return this.pendingSession !== null;
  }

  // ── cleanup ───────────────────────────────────────────────────

  /**
   * Kill any active PTY process and cancel the pending session.
   */
  cleanup(): void {
    if (this.pendingSession) {
      this.cancelPending('Cleaned up');
    }
  }

  // ── Private helpers ───────────────────────────────────────────

  private cancelPending(reason: string): void {
    if (!this.pendingSession) return;

    const pending = this.pendingSession;
    this.pendingSession = null;

    if (pending.userInputTimeout) {
      clearTimeout(pending.userInputTimeout);
    }

    if (pending.ptySession?.isAlive) {
      pending.ptySession.kill();
    }

    pending.resolve({
      handled: true,
      error: reason,
    });

    this.logger.info('Interactive session cancelled', {
      callbackId: pending.callbackId,
      reason,
    });
  }

  private spawnPtySession(
    pending: PendingSession,
    requestId: string,
    threadKey: string,
  ): void {
    if (!this.ptyFactory) return;

    try {
      const { session, result } = this.ptyFactory(pending.command, {
        onPrompt: (promptInfo: PromptInfo) => {
          if (this.pendingSession?.callbackId !== requestId) return;

          this.logger.info('Interactive prompt detected', {
            type: promptInfo.type,
            text: promptInfo.text.slice(0, 200),
            menuOptions: promptInfo.menuOptions?.length,
          });

          this.resetUserTimeout(pending, requestId);

          // Build and post prompt blocks
          const outputContext = pending.outputSoFar.length > 1500
            ? '...' + pending.outputSoFar.slice(-1500)
            : pending.outputSoFar;

          const blocks = buildInteractivePromptBlocks({
            command: pending.command,
            requestId,
            promptType: promptInfo.type,
            promptText: promptInfo.text,
            outputContext,
            menuOptions: promptInfo.menuOptions,
          });

          // Try updating existing message; if it fails, post a fresh one
          // so the prompt is still visible to the user.
          if (pending.messageTs) {
            this.slack.updateMessage(
              pending.channel,
              pending.messageTs,
              `Interactive: ${pending.command}`,
              blocks,
            ).catch((err) => {
              this.logger.warn('Failed to update interactive message, posting new', {
                error: err instanceof Error ? err.message : String(err),
              });
              pending.messageTs = undefined;
              this.postNewMessage(pending, requestId, blocks);
            });
          } else {
            this.postNewMessage(pending, requestId, blocks);
          }
        },
        onOutput: (chunk: string) => {
          if (this.pendingSession?.callbackId !== requestId) return;

          pending.outputSoFar += chunk;

          const now = Date.now();
          if (now - pending.lastOutputUpdate >= INTERACTIVE_OUTPUT_THROTTLE_MS && pending.messageTs) {
            pending.lastOutputUpdate = now;

            const displayOutput = pending.outputSoFar.length > 2900
              ? '...' + pending.outputSoFar.slice(-2900)
              : pending.outputSoFar;

            if (displayOutput.trim()) {
              const blocks = buildInteractiveStreamBlocks({
                command: pending.command,
                requestId,
                displayOutput,
              });
              this.updateSlackMessage(pending, threadKey, blocks);
            }
          }
        },
      });

      pending.ptySession = session;

      // Handle PTY completion
      result.then((ptyResult) => {
        if (this.pendingSession?.callbackId !== requestId) return;

        this.pendingSession = null;
        if (pending.userInputTimeout) clearTimeout(pending.userInputTimeout);

        this.logger.info('Interactive PTY session completed', {
          command: pending.command,
          exitCode: ptyResult.exitCode,
          timedOut: ptyResult.timedOut,
        });

        // Update Slack with completion
        const displayOutput = ptyResult.output.length > 2900
          ? '...' + ptyResult.output.slice(-2900)
          : ptyResult.output;

        const completedBlocks = buildInteractiveCompletedBlocks({
          command: pending.command,
          exitCode: ptyResult.exitCode,
          timedOut: ptyResult.timedOut,
          displayOutput: displayOutput.trim() || undefined,
        });
        this.updateSlackMessage(pending, threadKey, completedBlocks);

        // Resolve the bridge promise
        const outputForClaude = ptyResult.output.length > 10000
          ? ptyResult.output.slice(0, 5000) + '\n...[truncated]...\n' + ptyResult.output.slice(-5000)
          : ptyResult.output;

        pending.resolve({
          handled: true,
          output: `[INTERACTIVE] Command completed.\nOutput:\n${outputForClaude}\nExit code: ${ptyResult.exitCode}${ptyResult.timedOut ? ' (timed out)' : ''}`,
        });
      });
    } catch (err) {
      this.logger.error('Failed to spawn PTY session', {
        command: pending.command,
        error: err instanceof Error ? err.message : String(err),
      });

      const errorBlocks = buildInteractiveFailedBlocks({
        command: pending.command,
        error: err instanceof Error ? err.message : String(err),
      });
      this.updateSlackMessage(pending, threadKey, errorBlocks);

      if (this.pendingSession?.callbackId === requestId) {
        this.pendingSession = null;
        if (pending.userInputTimeout) clearTimeout(pending.userInputTimeout);
        pending.resolve({
          handled: true,
          error: `Failed to start: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  }

  private resetUserTimeout(pending: PendingSession, requestId: string): void {
    if (pending.userInputTimeout) clearTimeout(pending.userInputTimeout);
    pending.userInputTimeout = setTimeout(() => {
      if (this.pendingSession?.callbackId !== requestId) return;
      this.logger.warn('Interactive session timed out waiting for user input', {
        command: pending.command,
      });
      if (pending.ptySession?.isAlive) {
        pending.ptySession.kill();
      }
      this.pendingSession = null;
      pending.resolve({
        handled: true,
        error: 'Timed out waiting for user input',
      });
    }, INTERACTIVE_USER_TIMEOUT_MS);
  }

  private postNewMessage(
    pending: PendingSession,
    requestId: string,
    blocks: object[],
  ): void {
    this.slack.postMessage(
      pending.channel,
      pending.threadTs,
      `Interactive: ${pending.command}`,
      blocks,
    ).then(({ ts }) => {
      if (this.pendingSession?.callbackId === requestId) {
        pending.messageTs = ts;
      }
    }).catch((err) => {
      this.logger.error('Failed to post new interactive message', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  private updateSlackMessage(
    pending: PendingSession,
    _threadKey: string,
    blocks: object[],
  ): void {
    if (!pending.messageTs) return;
    this.slack.updateMessage(
      pending.channel,
      pending.messageTs!,
      `Interactive: ${pending.command}`,
      blocks,
    ).catch((err) => {
      this.logger.warn('Failed to update interactive message', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  private updateCompletedMessage(
    pending: PendingSession,
    payload: InteractionPayload,
  ): void {
    if (!pending.messageTs) return;
    const threadKey = `${pending.channel}:${pending.threadTs}`;

    const actionText = payload.action === 'cancel'
      ? 'Cancelled by user'
      : `User responded: ${payload.action}`;

    const blocks = buildInteractiveCompletedBlocks({
      command: pending.command,
      exitCode: payload.action === 'cancel' ? 1 : 0,
      timedOut: false,
      displayOutput: actionText,
    });

    this.updateSlackMessage(pending, threadKey, blocks);
  }
}
