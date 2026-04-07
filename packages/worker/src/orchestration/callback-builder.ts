// src/orchestration/callback-builder.ts — Factory for SessionCallbacks.
// Thin delegation layer: each callback forwards to the appropriate service.
// Ported from src/slack-handler/core/callbacks.ts.

import type { SessionCallbacks, ClaudeResult, TodoItem } from '../types.js';
import type { ProgressTracker } from '../services/progress-tracker.js';
import type { Logger } from '../logger.js';

// ── Deps ──────────────────────────────────────────────────────────────

export interface CallbackDeps {
  progress: ProgressTracker;
  logger: Logger;
  touchActivity: () => void;
  onToolStart: (toolName: string) => void;
  onToolEnd: () => void;
  onImageContent: (imageData: Buffer, mediaType: string, toolName?: string) => void;
  onTurnResult: (result: ClaudeResult) => boolean;
  onToolUseTracked: (toolName: string, input: Record<string, unknown>) => void;
  enqueueMainChunks: () => void;
  enqueueTodoChunks: () => void;
  enqueueTodoStop: () => void;
  setTypingStatus: (status: string) => void;
}

// ── Factory ───────────────────────────────────────────────────────────

export function buildCallbacks(deps: CallbackDeps): SessionCallbacks {
  const { progress, logger, touchActivity, onToolStart, onToolEnd, onImageContent, onTurnResult, onToolUseTracked, enqueueMainChunks, enqueueTodoChunks, enqueueTodoStop, setTypingStatus } = deps;

  // Mutable per-invocation state
  let pendingStreamText = '';
  let pendingThinkingText = '';

  const callbacks: SessionCallbacks = {
    // ── onSessionInit ────────────────────────────────────────────

    onSessionInit(_sessionId: string): void {
      touchActivity();
    },

    // ── onAssistantText ──────────────────────────────────────────

    onAssistantText(_text: string): void {
      progress.finalizeCurrentCard();
      touchActivity();
      setTypingStatus('is composing a response...');
    },

    // ── onToolUse ────────────────────────────────────────────────

    onToolUse(toolName: string, input: Record<string, unknown>, toolUseId: string): void {
      touchActivity();
      onToolStart(toolName);
      onToolUseTracked(toolName, input);

      // Pass any accumulated thinking/stream text as reasoning before the tool use.
      // Prefer thinking text (model reasoning) over stream text (visible output).
      const reasoningText = pendingThinkingText.trim() ? pendingThinkingText : pendingStreamText;
      if (reasoningText.trim()) {
        progress.onReasoningText(reasoningText);
      }
      pendingThinkingText = '';
      pendingStreamText = '';

      // Track todo list updates
      if (toolName === 'TodoWrite' && Array.isArray(input.todos)) {
        const todos: TodoItem[] = (input.todos as Array<{ content?: unknown; status?: unknown; activeForm?: unknown }>).map((t) => ({
          content: typeof t.content === 'string' ? t.content : '',
          status: (t.status === 'in_progress' || t.status === 'completed') ? t.status : 'pending' as const,
          activeForm: typeof t.activeForm === 'string' ? t.activeForm : undefined,
        }));
        progress.onTodoUpdate(todos);
      }

      // Track TaskCreate
      if (toolName === 'TaskCreate' && typeof input.subject === 'string') {
        progress.onTaskCreate(
          input.subject,
          typeof input.activeForm === 'string' ? input.activeForm : undefined,
        );
      }

      // Track TaskUpdate
      if (toolName === 'TaskUpdate' && typeof input.taskId === 'string') {
        progress.onTaskUpdate(String(input.taskId), {
          status: typeof input.status === 'string' ? input.status : undefined,
          subject: typeof input.subject === 'string' ? input.subject : undefined,
          activeForm: typeof input.activeForm === 'string' ? input.activeForm : undefined,
        });
      }

      // Delegate to progress tracker
      progress.onToolUse(toolName, input, toolUseId);

      // Update typing indicator
      setTypingStatus(progress.buildTypingText(toolName, input));

      // Enqueue stream chunks
      if (
        toolName === 'TodoWrite' ||
        toolName === 'TaskCreate' ||
        toolName === 'TaskUpdate' ||
        toolName === 'TaskList'
      ) {
        enqueueTodoChunks();
        // Close the todo stream when all items are completed or list is cleared
        if (progress.todoStreamDone()) {
          enqueueTodoStop();
        }
      } else {
        enqueueMainChunks();
      }
    },

    // ── onToolResult ─────────────────────────────────────────────

    onToolResult(toolName: string, toolUseId: string, result: string): void {
      touchActivity();
      onToolEnd();
      progress.onToolResult(toolName, toolUseId, result);
      setTypingStatus(progress.buildThinkingText());
      enqueueMainChunks();
    },

    // ── onToolProgress ───────────────────────────────────────────

    onToolProgress(_toolName: string, elapsedSeconds: number, toolUseId: string): void {
      touchActivity();
      setTypingStatus(progress.buildTypingTextForTool(toolUseId, elapsedSeconds));
    },

    // ── onStreamDelta ────────────────────────────────────────────

    onStreamDelta(textDelta: string): void {
      touchActivity();
      pendingStreamText += textDelta;
    },

    // ── onThinkingDelta ──────────────────────────────────────────

    onThinkingDelta(textDelta: string): void {
      touchActivity();
      pendingThinkingText += textDelta;
    },

    // ── onStatusChange ───────────────────────────────────────────

    onStatusChange(status: 'compacting' | null): void {
      touchActivity();
      progress.onCompactionStatus(status === 'compacting');
      enqueueMainChunks();
    },

    // ── onImageContent ───────────────────────────────────────────

    onImageContent(imageData: Buffer, mediaType: string, toolName?: string): void {
      touchActivity();
      onImageContent(imageData, mediaType, toolName);
    },

    // ── onTurnResult ─────────────────────────────────────────────

    onTurnResult(result: ClaudeResult): boolean {
      touchActivity();
      pendingStreamText = '';
      pendingThinkingText = '';
      setTypingStatus('');
      return onTurnResult(result);
    },
  };

  return callbacks;
}
