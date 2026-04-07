// tests/unit/types.test.ts
import type {
  BuddyConfig, ActiveExecution, ClaudeResult, UsageInfo,
  ExecEntry, BufferedMessage, TodoItem, ToolRisk,
  PendingPermission, PendingQuestion, PendingPlanReview, PendingInteractive,
  SessionCallbacks, InvokeParams, ParsedCommand, CommandResult,
} from '../../src/types';

describe('types', () => {
  it('exports all required interfaces (compile-time check)', () => {
    // This test validates that all types are exported and importable.
    // If any type is missing, TypeScript compilation will fail.
    const config: Partial<BuddyConfig> = { claudeModel: 'test' };
    const result: Partial<ClaudeResult> = { isError: false };
    const usage: Partial<UsageInfo> = { inputTokens: 0 };
    const entry: ExecEntry = { type: 'text', content: 'hello' };
    const msg: Partial<BufferedMessage> = { prompt: 'hi' };
    expect(config.claudeModel).toBe('test');
    expect(result.isError).toBe(false);
    expect(usage.inputTokens).toBe(0);
    expect(entry.type).toBe('text');
    expect(msg.prompt).toBe('hi');
  });
});
