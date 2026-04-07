// tests/unit/orchestration/callback-builder.test.ts
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { buildCallbacks } from '../../../src/orchestration/callback-builder';
import { ProgressTracker } from '../../../src/services/progress-tracker';
import { Logger } from '../../../src/logger';
import type { SessionCallbacks, ClaudeResult } from '../../../src/types';

describe('buildCallbacks', () => {
  let progress: ProgressTracker;
  let logger: Logger;
  let touchActivity: jest.Mock;
  let onToolStart: jest.Mock;
  let onToolEnd: jest.Mock;
  let onToolUseTracked: jest.Mock;
  let onImageContent: jest.Mock;
  let onTurnResult: jest.Mock;
  let enqueueMainChunks: jest.Mock;
  let enqueueTodoChunks: jest.Mock;
  let enqueueTodoStop: jest.Mock;
  let setTypingStatus: jest.Mock;
  let callbacks: SessionCallbacks;

  beforeEach(() => {
    progress = new ProgressTracker();
    logger = new Logger({ level: 'warn' });
    touchActivity = jest.fn();
    onToolStart = jest.fn();
    onToolEnd = jest.fn();
    onToolUseTracked = jest.fn();
    onImageContent = jest.fn();
    onTurnResult = jest.fn(() => false);
    enqueueMainChunks = jest.fn();
    enqueueTodoChunks = jest.fn();
    enqueueTodoStop = jest.fn();
    setTypingStatus = jest.fn();

    callbacks = buildCallbacks({
      progress,
      logger,
      touchActivity,
      onToolStart,
      onToolEnd,
      onToolUseTracked,
      onImageContent,
      onTurnResult,
      enqueueMainChunks,
      enqueueTodoChunks,
      enqueueTodoStop,
      setTypingStatus,
    });
  });

  // ── Returns a SessionCallbacks object ───────────────────────────

  it('returns a SessionCallbacks object with all required methods', () => {
    expect(callbacks).toBeDefined();
    expect(typeof callbacks.onSessionInit).toBe('function');
    expect(typeof callbacks.onAssistantText).toBe('function');
    expect(typeof callbacks.onToolUse).toBe('function');
    expect(typeof callbacks.onToolResult).toBe('function');
    expect(typeof callbacks.onToolProgress).toBe('function');
    expect(typeof callbacks.onStreamDelta).toBe('function');
    expect(typeof callbacks.onThinkingDelta).toBe('function');
    expect(typeof callbacks.onStatusChange).toBe('function');
    expect(typeof callbacks.onImageContent).toBe('function');
    expect(typeof callbacks.onTurnResult).toBe('function');
  });

  // ── onSessionInit ─────────────────────────────────────────────

  describe('onSessionInit', () => {
    it('touches activity', () => {
      callbacks.onSessionInit('sess-123');
      expect(touchActivity).toHaveBeenCalled();
    });
  });

  // ── onAssistantText ───────────────────────────────────────────

  describe('onAssistantText', () => {
    it('finalizes current card on progress tracker', () => {
      const spy = jest.spyOn(progress, 'finalizeCurrentCard');
      callbacks.onAssistantText('Some response text');
      expect(spy).toHaveBeenCalled();
    });

    it('touches activity', () => {
      callbacks.onAssistantText('text');
      expect(touchActivity).toHaveBeenCalled();
    });
  });

  // ── onToolUse ─────────────────────────────────────────────────

  describe('onToolUse', () => {
    it('delegates to ProgressTracker.onToolUse', () => {
      const spy = jest.spyOn(progress, 'onToolUse');
      callbacks.onToolUse('Read', { file_path: '/a.ts' }, 'tu-1');
      expect(spy).toHaveBeenCalledWith('Read', { file_path: '/a.ts' }, 'tu-1');
    });

    it('touches activity', () => {
      callbacks.onToolUse('Read', { file_path: '/a.ts' }, 'tu-1');
      expect(touchActivity).toHaveBeenCalled();
    });

    it('calls enqueueMainChunks for regular tools', () => {
      callbacks.onToolUse('Read', { file_path: '/a.ts' }, 'tu-1');
      expect(enqueueMainChunks).toHaveBeenCalled();
    });

    it('calls enqueueTodoChunks for TodoWrite tool', () => {
      callbacks.onToolUse('TodoWrite', { todos: [] }, 'tu-tw');
      expect(enqueueTodoChunks).toHaveBeenCalled();
    });

    it('calls enqueueTodoChunks for TaskCreate tool', () => {
      callbacks.onToolUse('TaskCreate', { subject: 'Test' }, 'tu-tc');
      expect(enqueueTodoChunks).toHaveBeenCalled();
    });

    it('calls enqueueTodoChunks for TaskUpdate tool', () => {
      callbacks.onToolUse('TaskUpdate', { taskId: '1', status: 'completed' }, 'tu-tup');
      expect(enqueueTodoChunks).toHaveBeenCalled();
    });

    it('delegates onTodoUpdate for TodoWrite with todos array', () => {
      const spy = jest.spyOn(progress, 'onTodoUpdate');
      const todos = [{ content: 'Fix bug', status: 'pending' }];
      callbacks.onToolUse('TodoWrite', { todos }, 'tu-tw');
      expect(spy).toHaveBeenCalled();
    });

    it('delegates onTaskCreate for TaskCreate tool', () => {
      const spy = jest.spyOn(progress, 'onTaskCreate');
      callbacks.onToolUse('TaskCreate', { subject: 'Build feature' }, 'tu-tc');
      expect(spy).toHaveBeenCalledWith('Build feature', undefined);
    });

    it('delegates onTaskUpdate for TaskUpdate tool', () => {
      // First create a task so there is something to update
      progress.onTaskCreate('Build feature');
      const spy = jest.spyOn(progress, 'onTaskUpdate');
      callbacks.onToolUse('TaskUpdate', { taskId: '1', status: 'in_progress' }, 'tu-tup');
      expect(spy).toHaveBeenCalledWith('1', {
        status: 'in_progress',
        subject: undefined,
        activeForm: undefined,
      });
    });
  });

  // ── onToolResult ──────────────────────────────────────────────

  describe('onToolResult', () => {
    it('delegates to ProgressTracker.onToolResult', () => {
      const spy = jest.spyOn(progress, 'onToolResult');
      callbacks.onToolUse('Read', { file_path: '/a.ts' }, 'tu-1');
      callbacks.onToolResult('Read', 'tu-1', 'file content');
      expect(spy).toHaveBeenCalledWith('Read', 'tu-1', 'file content');
    });

    it('touches activity', () => {
      callbacks.onToolResult('Read', 'tu-1', 'content');
      expect(touchActivity).toHaveBeenCalled();
    });

    it('calls enqueueMainChunks', () => {
      callbacks.onToolResult('Read', 'tu-1', 'content');
      expect(enqueueMainChunks).toHaveBeenCalled();
    });

    it('does not call enqueueTodoChunks (tool results no longer affect todos)', () => {
      callbacks.onToolResult('Read', 'tu-1', 'content');
      expect(enqueueTodoChunks).not.toHaveBeenCalled();
    });
  });

  // ── onToolProgress ────────────────────────────────────────────

  describe('onToolProgress', () => {
    it('touches activity', () => {
      callbacks.onToolProgress('Read', 5, 'tu-1');
      expect(touchActivity).toHaveBeenCalled();
    });
  });

  // ── onStreamDelta ─────────────────────────────────────────────

  describe('onStreamDelta', () => {
    it('touches activity', () => {
      callbacks.onStreamDelta('Hello');
      expect(touchActivity).toHaveBeenCalled();
    });

    it('accumulates streamed text available via getStreamedText()', () => {
      callbacks.onStreamDelta('Hello ');
      callbacks.onStreamDelta('world');
      // The accumulated text feeds into onToolUse reasoning
      // We verify by checking that subsequent onToolUse uses it as reasoning
      const spy = jest.spyOn(progress, 'onReasoningText');
      callbacks.onToolUse('Read', { file_path: '/a.ts' }, 'tu-1');
      expect(spy).toHaveBeenCalledWith('Hello world');
    });
  });

  // ── onThinkingDelta ──────────────────────────────────────────

  describe('onThinkingDelta', () => {
    it('touches activity', () => {
      callbacks.onThinkingDelta('Reasoning about the task');
      expect(touchActivity).toHaveBeenCalled();
    });

    it('accumulated thinking text is preferred over stream text for reasoning', () => {
      callbacks.onStreamDelta('Some visible text');
      callbacks.onThinkingDelta('Internal reasoning about what to do');
      const spy = jest.spyOn(progress, 'onReasoningText');
      callbacks.onToolUse('Read', { file_path: '/a.ts' }, 'tu-1');
      expect(spy).toHaveBeenCalledWith('Internal reasoning about what to do');
    });

    it('falls back to stream text when no thinking text', () => {
      callbacks.onStreamDelta('Visible reasoning');
      const spy = jest.spyOn(progress, 'onReasoningText');
      callbacks.onToolUse('Read', { file_path: '/a.ts' }, 'tu-1');
      expect(spy).toHaveBeenCalledWith('Visible reasoning');
    });

    it('resets thinking text after turn result', () => {
      callbacks.onThinkingDelta('Some thinking');
      callbacks.onTurnResult({
        result: 'Done',
        isError: false,
        sessionId: 'sess-1',
        costUsd: 0,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, contextWindowPercent: 0, numTurns: 1 },
      });
      const spy = jest.spyOn(progress, 'onReasoningText');
      callbacks.onToolUse('Read', { file_path: '/a.ts' }, 'tu-1');
      expect(spy).not.toHaveBeenCalled();
    });
  });

  // ── onStatusChange ────────────────────────────────────────────

  describe('onStatusChange', () => {
    it('delegates to ProgressTracker.onCompactionStatus for compacting', () => {
      const spy = jest.spyOn(progress, 'onCompactionStatus');
      callbacks.onStatusChange('compacting');
      expect(spy).toHaveBeenCalledWith(true);
    });

    it('delegates to ProgressTracker.onCompactionStatus(false) for null', () => {
      const spy = jest.spyOn(progress, 'onCompactionStatus');
      callbacks.onStatusChange(null);
      expect(spy).toHaveBeenCalledWith(false);
    });

    it('touches activity', () => {
      callbacks.onStatusChange('compacting');
      expect(touchActivity).toHaveBeenCalled();
    });

    it('calls enqueueMainChunks', () => {
      callbacks.onStatusChange('compacting');
      expect(enqueueMainChunks).toHaveBeenCalled();
    });
  });

  // ── onImageContent ────────────────────────────────────────────

  describe('onImageContent', () => {
    it('delegates to the provided onImageContent handler', () => {
      const buf = Buffer.from('fake-image');
      callbacks.onImageContent(buf, 'image/png', 'Screenshot');
      expect(onImageContent).toHaveBeenCalledWith(buf, 'image/png', 'Screenshot');
    });

    it('touches activity', () => {
      callbacks.onImageContent(Buffer.from('img'), 'image/png');
      expect(touchActivity).toHaveBeenCalled();
    });
  });

  // ── onTurnResult ──────────────────────────────────────────────

  describe('onTurnResult', () => {
    it('delegates to the provided onTurnResult handler', () => {
      const result: ClaudeResult = {
        result: 'Done',
        isError: false,
        sessionId: 'sess-1',
        costUsd: 0.01,
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          contextWindowPercent: 10,
          numTurns: 1,
        },
      };
      callbacks.onTurnResult(result);
      expect(onTurnResult).toHaveBeenCalledWith(result);
    });

    it('returns the value from the handler', () => {
      onTurnResult.mockReturnValue(true);
      const result: ClaudeResult = {
        result: 'Done',
        isError: false,
        sessionId: 'sess-1',
        costUsd: 0.01,
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          contextWindowPercent: 10,
          numTurns: 1,
        },
      };
      expect(callbacks.onTurnResult(result)).toBe(true);
    });

    it('touches activity', () => {
      const result: ClaudeResult = {
        result: 'Done',
        isError: false,
        sessionId: 'sess-1',
        costUsd: 0.01,
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          contextWindowPercent: 10,
          numTurns: 1,
        },
      };
      callbacks.onTurnResult(result);
      expect(touchActivity).toHaveBeenCalled();
    });

    it('resets streamed text state after turn', () => {
      // Accumulate some text
      callbacks.onStreamDelta('Some reasoning');
      // Complete the turn
      const result: ClaudeResult = {
        result: 'Done',
        isError: false,
        sessionId: 'sess-1',
        costUsd: 0,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          contextWindowPercent: 0,
          numTurns: 1,
        },
      };
      callbacks.onTurnResult(result);

      // After turn, streamed text should be reset
      // Verify by checking that onReasoningText is NOT called with old text
      const spy = jest.spyOn(progress, 'onReasoningText');
      callbacks.onToolUse('Read', { file_path: '/a.ts' }, 'tu-1');
      // If text was reset, onReasoningText is not called (no text to pass)
      expect(spy).not.toHaveBeenCalled();
    });
  });

  // ── Activity tracking ─────────────────────────────────────────

  describe('activity tracking', () => {
    it('touchActivity is called on every callback type', () => {
      callbacks.onSessionInit('s1');
      callbacks.onAssistantText('text');
      callbacks.onToolUse('Read', {}, 'tu-1');
      callbacks.onToolResult('Read', 'tu-1', 'res');
      callbacks.onToolProgress('Read', 3, 'tu-1');
      callbacks.onStreamDelta('delta');
      callbacks.onThinkingDelta('thinking');
      callbacks.onStatusChange('compacting');
      callbacks.onImageContent(Buffer.from('x'), 'image/png');
      callbacks.onTurnResult({
        result: 'Done',
        isError: false,
        sessionId: 'sess-1',
        costUsd: 0,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          contextWindowPercent: 0,
          numTurns: 1,
        },
      });

      // 10 callbacks = 10 touchActivity calls
      expect(touchActivity).toHaveBeenCalledTimes(10);
    });
  });
});
