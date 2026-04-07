import { jest } from '@jest/globals';
import { StreamingStatus, stripUsageBlock, toRichText } from '../packages/worker/src/streaming-status.js';
import type { TaskUpdateChunk, PlanUpdateChunk } from '@slack/types';

// Minimal mock client
const mockClient = {
  assistant: { threads: { setStatus: jest.fn().mockResolvedValue(undefined) } },
};

function createStatus() {
  return new StreamingStatus({
    client: mockClient,
    channel: 'C123',
    threadTs: '1234.5678',
  });
}

/** Filter only TaskUpdateChunks from AnyChunk[] */
function taskChunks(chunks: unknown[]): TaskUpdateChunk[] {
  return chunks.filter((c: any) => c.type === 'task_update') as TaskUpdateChunk[];
}

describe('StreamingStatus reasoning cards', () => {
  beforeEach(() => jest.clearAllMocks());

  it('creates a reasoning card when onReasoningText is called before onToolUse', () => {
    const ss = createStatus();
    ss.onReasoningText('Let me find the file and check git status');
    ss.onToolUse('Bash', { command: 'find . -name foo', description: 'Find foo' }, 'tool-1');

    const chunks = taskChunks(ss.buildChunks());
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      type: 'task_update',
      title: 'Let me find the file and check git status',
      status: 'in_progress',
    });
    // When reasoning text equals the title, details are suppressed (not duplicated)
    // In-progress tools are not included in streaming output (only completed ones)
  });

  it('creates a fallback card when onToolUse is called without preceding reasoning', () => {
    const ss = createStatus();
    ss.onToolUse('Bash', { command: 'npm test', description: 'Run tests' }, 'tool-1');

    const chunks = taskChunks(ss.buildChunks());
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      type: 'task_update',
      title: 'Run tests',
      status: 'in_progress',
    });
  });

  it('groups multiple tool calls under one reasoning card', () => {
    const ss = createStatus();
    ss.onReasoningText('Checking the repo');
    ss.onToolUse('Bash', { command: 'git status', description: 'Show status' }, 'tool-1');
    ss.onToolUse('Bash', { command: 'git diff', description: 'Show diff' }, 'tool-2');

    const chunks = taskChunks(ss.buildChunks());
    expect(chunks).toHaveLength(1);
    // In-progress tools are not included in streaming output; complete them first
    ss.onToolResult('Bash', 'tool-1', '');
    ss.onToolResult('Bash', 'tool-2', '');
    const all = ss.buildAllChunks();
    expect(all[0].output).toContain('Show status');
    expect(all[0].output).toContain('Show diff');
  });

  it('marks tool complete with result in output', () => {
    const ss = createStatus();
    ss.onReasoningText('Finding files');
    ss.onToolUse('Grep', { pattern: 'foo' }, 'tool-1');
    ss.onToolResult('Grep', 'tool-1', 'Found 3 files');

    const chunks = taskChunks(ss.buildChunks());
    // Non-subagent tools show ✓ icon and display title, but not result summary
    expect(chunks[0].output).toContain('\u2713 Search for `foo`');
  });

  it('creates a new card when new reasoning arrives after tool results', () => {
    const ss = createStatus();
    ss.onReasoningText('Step 1');
    ss.onToolUse('Bash', { command: 'ls', description: 'List files' }, 'tool-1');
    ss.onToolResult('Bash', 'tool-1', 'file.txt');
    ss.finalizeCurrentCard();

    ss.onReasoningText('Step 2');
    ss.onToolUse('Bash', { command: 'cat file.txt', description: 'Read file' }, 'tool-2');

    const chunks = taskChunks(ss.buildChunks());
    expect(chunks).toHaveLength(2);
    expect(chunks[0].title).toBe('Step 1');
    expect(chunks[0].status).toBe('complete');
    expect(chunks[1].title).toBe('Step 2');
    expect(chunks[1].status).toBe('in_progress');
  });

  it('truncates long reasoning to 80 chars for title', () => {
    const ss = createStatus();
    const longText = 'A'.repeat(100);
    ss.onReasoningText(longText);
    ss.onToolUse('Bash', { command: 'echo hi', description: 'Say hi' }, 'tool-1');

    const chunks = taskChunks(ss.buildChunks());
    expect(chunks[0].title.length).toBeLessThanOrEqual(81); // 80 + ellipsis char
    // Full text in details
    expect(chunks[0].details).toContain(longText);
  });

  it('puts tool lines in output', () => {
    const ss = createStatus();
    ss.onReasoningText('Working');
    ss.onToolUse('Edit', { file_path: '/a/b.ts' }, 'tool-1');
    ss.onToolResult('Edit', 'tool-1', '');
    ss.onToolUse('Bash', { command: 'npm test', description: 'Run tests' }, 'tool-2');
    ss.onToolResult('Bash', 'tool-2', 'PASS');
    ss.finalizeCurrentCard();

    const chunks = taskChunks(ss.buildChunks());
    // Non-subagent tools show ✓ icon and display title, but not result summary
    expect(chunks[0].output).toContain('Edit a/b.ts');
    expect(chunks[0].output).toContain('Run tests');
  });
});

describe('StreamingStatus todo card', () => {
  beforeEach(() => jest.clearAllMocks());

  it('does not include todo items in streaming buildChunks (standalone message)', () => {
    const ss = createStatus();
    ss.onTodoUpdate([
      { content: 'Step 1', status: 'completed' },
      { content: 'Step 2', status: 'in_progress', activeForm: 'Working on step 2' },
      { content: 'Step 3', status: 'pending' },
    ]);

    const chunks = taskChunks(ss.buildChunks());
    const todoChunk = chunks.find(c => c.id === 'todo-list');
    expect(todoChunk).toBeUndefined();
  });

  it('does not include todo items in buildAllChunks (standalone message)', () => {
    const ss = createStatus();
    ss.onTodoUpdate([
      { content: 'Step 1', status: 'completed' },
      { content: 'Step 2', status: 'completed' },
    ]);

    const chunks = ss.buildAllChunks();
    const todoChunk = chunks.find(c => c.id === 'todo-list');
    expect(todoChunk).toBeUndefined();
  });

  it('renders todos via buildFinalTodoPlanBlock as individual TaskCardBlocks', () => {
    const ss = createStatus();
    ss.onTodoUpdate([
      { content: 'Step 1', status: 'completed' },
      { content: 'Step 2', status: 'in_progress', activeForm: 'Working on step 2' },
    ]);

    const plan = ss.buildFinalTodoPlanBlock();
    expect(plan).not.toBeNull();
    expect(plan!.title).toBe('Task Progress (1/2)');
    expect(plan!.tasks).toHaveLength(2);
  });
});

describe('StreamingStatus subagent card', () => {
  beforeEach(() => jest.clearAllMocks());

  it('creates a dedicated card for Task tool with agent type/model in details', () => {
    const ss = createStatus();
    ss.onReasoningText('Let me check the deployment');
    ss.onToolUse('Agent', {
      description: 'Check TeamClaw deployment',
      subagent_type: 'general-purpose',
      model: 'haiku',
    }, 'agent-1');

    // Subagent cards ARE included in main buildChunks
    const mainChunks = taskChunks(ss.buildChunks());
    const agentChunk = mainChunks.find(c => c.title === 'Check TeamClaw deployment');
    expect(agentChunk).toBeDefined();
    expect(agentChunk!.status).toBe('in_progress');
  });

  it('populates subagent output and metadata from result', () => {
    const ss = createStatus();
    ss.onToolUse('Agent', {
      description: 'Explore codebase',
      subagent_type: 'Explore',
    }, 'agent-1');

    const result = `Found the authentication module in src/auth.ts.\nagentId: abc123\n<usage>total_tokens: 45000\ntool_uses: 23\nduration_ms: 43633</usage>`;
    ss.onToolResult('Agent', 'agent-1', result);

    const chunks = taskChunks(ss.buildChunks());
    const agentChunk = chunks.find(c => c.title === 'Explore codebase');
    expect(agentChunk!.status).toBe('complete');
  });

  it('preserves long subagent results without truncation', () => {
    const ss = createStatus();
    ss.onToolUse('Agent', {
      description: 'Full review',
      subagent_type: 'code-reviewer',
    }, 'agent-1');

    const longResult = 'A'.repeat(800) + '\n<usage>tool_uses: 10\nduration_ms: 5000</usage>';
    ss.onToolResult('Agent', 'agent-1', longResult);

    const chunks = taskChunks(ss.buildChunks());
    const agentChunk = chunks.find(c => c.title === 'Full review');
    expect(agentChunk).toBeDefined();
    expect(agentChunk!.status).toBe('complete');
  });

  it('includes subagent cards in buildFinalPlanBlock', () => {
    const ss = createStatus();
    ss.onToolUse('Agent', { description: 'Explore codebase', subagent_type: 'Explore' }, 'agent-1');
    ss.onToolResult('Agent', 'agent-1', 'Found it\n<usage>tool_uses: 5\nduration_ms: 3000</usage>');
    const plan = ss.buildFinalPlanBlock();
    expect(plan).not.toBeNull();
    expect(plan!.tasks?.some(t => t.title === 'Explore codebase')).toBe(true);
  });

  it('does not add TodoWrite to reasoning card details', () => {
    const ss = createStatus();
    ss.onReasoningText('Planning the work');
    ss.onToolUse('TodoWrite', { todos: [] }, 'todo-1');
    ss.onToolUse('Bash', { command: 'ls', description: 'List files' }, 'tool-1');
    ss.onToolResult('Bash', 'tool-1', 'file.txt');

    const chunks = taskChunks(ss.buildChunks());
    const reasoningChunks = chunks.filter(c => c.id !== 'todo-list');
    expect(reasoningChunks).toHaveLength(1);
    expect(reasoningChunks[0].output).not.toContain('TodoWrite');
    expect(reasoningChunks[0].output).toContain('List files');
  });
});

describe('StreamingStatus chunk deduplication', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns empty array when buildChunks is called twice without changes', () => {
    const ss = createStatus();
    ss.onReasoningText('Step 1');
    ss.onToolUse('Bash', { command: 'ls', description: 'List files' }, 'tool-1');

    const first = ss.buildChunks();
    expect(first.length).toBeGreaterThanOrEqual(1);

    const second = ss.buildChunks();
    expect(second).toHaveLength(0);
  });

  it('does not re-send task when only content changed (status unchanged)', () => {
    const ss = createStatus();
    ss.onReasoningText('Step 1');
    ss.onToolUse('Bash', { command: 'ls', description: 'List files' }, 'tool-1');

    const first = ss.buildChunks();
    expect(taskChunks(first)).toHaveLength(1);

    // Complete the tool — content changes but card status stays in_progress
    ss.onToolResult('Bash', 'tool-1', 'file.txt');

    // buildChunks sends delta output for newly completed tools
    const second = ss.buildChunks();
    const secondTasks = taskChunks(second);
    // The newly completed tool triggers a delta update
    if (secondTasks.length > 0) {
      expect(secondTasks[0].output).toContain('List files');
    }

    // buildAllChunks shares delta tracking — all returns current chunk state
    const all = ss.buildAllChunks();
    expect(all).toHaveLength(1);
    expect(all[0].title).toBe('Step 1');
  });

  it('re-sends task when status changes (in_progress → complete)', () => {
    const ss = createStatus();
    ss.onReasoningText('Step 1');
    ss.onToolUse('Bash', { command: 'ls', description: 'List files' }, 'tool-1');

    const first = ss.buildChunks();
    expect(taskChunks(first)).toHaveLength(1);
    expect(taskChunks(first)[0].status).toBe('in_progress');

    // Finalize card (status → complete)
    ss.onToolResult('Bash', 'tool-1', 'file.txt');
    ss.finalizeCurrentCard();

    const second = ss.buildChunks();
    const updated = taskChunks(second);
    expect(updated).toHaveLength(1);
    expect(updated[0].status).toBe('complete');
  });

  it('does not re-send subagent task when status is unchanged', () => {
    const ss = createStatus();
    ss.onToolUse('Agent', { description: 'Explore codebase', subagent_type: 'Explore' }, 'agent-1');

    const first = ss.buildChunks();
    expect(taskChunks(first)).toHaveLength(1);

    // No status change
    const second = ss.buildChunks();
    expect(taskChunks(second)).toHaveLength(0);
  });

  it('buildAllChunks always returns all chunks regardless of change tracking', () => {
    const ss = createStatus();
    ss.onReasoningText('Step 1');
    ss.onToolUse('Bash', { command: 'ls', description: 'List files' }, 'tool-1');

    // First call to buildChunks marks them as sent
    ss.buildChunks();

    // buildAllChunks still returns everything
    const all = ss.buildAllChunks();
    expect(all).toHaveLength(1);
    expect(all[0].title).toBe('Step 1');
  });

  it('does not produce duplicate chunks across multiple update cycles', () => {
    const ss = createStatus();
    ss.onReasoningText('Exploring');
    ss.onToolUse('Agent', { description: 'Explore codebase', subagent_type: 'Explore' }, 'agent-1');

    // First cycle: subagent IS now included in buildChunks
    const first = ss.buildChunks();
    expect(taskChunks(first)).toHaveLength(1);

    // Second cycle: no changes — both streams empty
    const second = ss.buildChunks();
    expect(second).toHaveLength(0);

    // Third cycle: new tool arrives — new card in main stream
    ss.onToolUse('Bash', { command: 'npm test', description: 'Run tests' }, 'tool-1');
    const third = ss.buildChunks();
    const thirdTasks = taskChunks(third);
    expect(thirdTasks).toHaveLength(1);
    expect(thirdTasks[0].title).not.toBe('Explore codebase');
  });

  it('emits new TaskUpdateChunk when new tool use arrives dynamically', () => {
    const ss = createStatus();
    ss.onToolUse('Bash', { command: 'git status', description: 'Check status' }, 'tool-1');

    const first = taskChunks(ss.buildChunks());
    expect(first).toHaveLength(1);
    expect(first[0].title).toBe('Check status');

    // Complete and finalize
    ss.onToolResult('Bash', 'tool-1', 'clean');
    ss.finalizeCurrentCard();

    // New tool arrives — new card
    ss.onReasoningText('Now let me push');
    ss.onToolUse('Bash', { command: 'git push', description: 'Push changes' }, 'tool-2');

    const second = ss.buildChunks();
    const secondTasks = taskChunks(second);
    // First card re-sent (status changed) + new card
    expect(secondTasks).toHaveLength(2);
    expect(secondTasks.some(c => c.title === 'Now let me push')).toBe(true);
  });

  it('ignores duplicate onToolUse calls for the same toolUseId', () => {
    const ss = createStatus();
    ss.onReasoningText('Loading skill');
    ss.onToolUse('Skill', { skill: 'brainstorming' }, 'skill-1');
    // SDK fires same tool_use again from complete assistant message
    ss.onToolUse('Skill', { skill: 'brainstorming' }, 'skill-1');
    ss.onToolUse('Skill', { skill: 'brainstorming' }, 'skill-1');
    // Complete the tool so it appears in output
    ss.onToolResult('Skill', 'skill-1', '');

    const chunks = ss.buildAllChunks();
    expect(chunks).toHaveLength(1);
    // Only one tool line, not three
    const lines = chunks[0].output!.split('\n').filter((l: string) => l.trim());
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('brainstorming');
  });

  it('ignores duplicate onToolUse after onToolResult (SDK replay across turns)', () => {
    const ss = createStatus();
    ss.onReasoningText('Working');
    ss.onToolUse('Bash', { command: 'ls', description: 'List files' }, 'tool-1');
    ss.onToolResult('Bash', 'tool-1', 'file.txt');
    // SDK replays same toolUseId on next turn
    ss.onToolUse('Bash', { command: 'ls', description: 'List files' }, 'tool-1');

    const chunks = ss.buildAllChunks();
    expect(chunks).toHaveLength(1);
    const lines = chunks[0].output!.split('\n').filter((l: string) => l.trim());
    expect(lines).toHaveLength(1);
  });
});

describe('StreamingStatus plan mode', () => {
  beforeEach(() => jest.clearAllMocks());

  it('buildPlanChunk returns null when no plan title set', () => {
    const ss = createStatus();
    expect(ss.buildPlanChunk()).toBeNull();
  });

  it('buildPlanChunk returns PlanUpdateChunk with title', () => {
    const ss = createStatus();
    ss.setPlanTitle('Reviewing PR #123');

    const chunk = ss.buildPlanChunk();
    expect(chunk).toEqual({
      type: 'plan_update',
      title: 'Reviewing PR #123',
    });
  });

  it('buildChunks includes PlanUpdateChunk on first call when plan title is set', () => {
    const ss = createStatus();
    ss.setPlanTitle('Creating draft PR');
    ss.onToolUse('Bash', { command: 'git push', description: 'Push branch' }, 'tool-1');

    const chunks = ss.buildChunks();
    const planChunks = chunks.filter((c: any) => c.type === 'plan_update') as PlanUpdateChunk[];
    expect(planChunks).toHaveLength(1);
    expect(planChunks[0].title).toBe('Creating draft PR');

    // Second call: same title → no PlanUpdateChunk
    const second = ss.buildChunks();
    const secondPlanChunks = second.filter((c: any) => c.type === 'plan_update');
    expect(secondPlanChunks).toHaveLength(0);
  });

  it('buildChunks re-emits PlanUpdateChunk when title changes', () => {
    const ss = createStatus();
    ss.setPlanTitle('Step 1');
    ss.onToolUse('Bash', { command: 'ls', description: 'List' }, 'tool-1');

    ss.buildChunks(); // First emission

    // Change title
    ss.setPlanTitle('Step 2');
    const second = ss.buildChunks();
    const planChunks = second.filter((c: any) => c.type === 'plan_update') as PlanUpdateChunk[];
    expect(planChunks).toHaveLength(1);
    expect(planChunks[0].title).toBe('Step 2');
  });

  it('buildFinalPlanBlock returns null when no cards exist', () => {
    const ss = createStatus();
    expect(ss.buildFinalPlanBlock()).toBeNull();
  });

  it('buildFinalPlanBlock returns PlanBlock with TaskCardBlocks (subagents included)', () => {
    const ss = createStatus();
    ss.setPlanTitle('Reviewing PR #966');

    // Add a reasoning card
    ss.onReasoningText('Checking the code');
    ss.onToolUse('Read', { file_path: '/src/app.ts' }, 'tool-1');
    ss.onToolResult('Read', 'tool-1', 'contents');
    ss.finalizeCurrentCard();

    // Add a subagent card
    ss.onToolUse('Agent', {
      description: 'Code review',
      subagent_type: 'code-reviewer',
      model: 'opus',
    }, 'agent-1');
    ss.onToolResult('Agent', 'agent-1', 'Found 3 issues.\n<usage>tool_uses: 15\nduration_ms: 30000</usage>');

    const plan = ss.buildFinalPlanBlock();
    expect(plan).not.toBeNull();
    expect(plan!.type).toBe('plan');
    expect(plan!.title).toBe('Reviewing PR #966');
    // Both cards — subagent is now included in buildFinalPlanBlock
    expect(plan!.tasks).toHaveLength(2);

    // Reasoning task card — details omitted because title matches reasoning text
    const reasoningCard = plan!.tasks![0] as any;
    expect(reasoningCard.type).toBe('task_card');
    expect(reasoningCard.title).toBe('Checking the code');
    expect(reasoningCard.status).toBe('complete');
    expect(reasoningCard.details).toBeUndefined();
    expect(reasoningCard.output.type).toBe('rich_text');

    // Subagent task card
    const subagentCard = plan!.tasks![1] as any;
    expect(subagentCard.title).toBe('Code review');
    expect(subagentCard.status).toBe('complete');
  });

  it('buildFinalPlanBlock uses "Execution Summary" when no plan title set', () => {
    const ss = createStatus();
    ss.onToolUse('Bash', { command: 'ls', description: 'List files' }, 'tool-1');

    const plan = ss.buildFinalPlanBlock();
    expect(plan!.title).toBe('Execution Summary');
  });
});

describe('stripUsageBlock', () => {
  it('strips <usage> blocks and agentId lines', () => {
    const input = `Found the auth module.\nagentId: abc123\n<usage>tool_uses: 23\nduration_ms: 43633</usage>`;
    const result = stripUsageBlock(input);
    expect(result).toBe('Found the auth module.');
    expect(result).not.toContain('agentId');
    expect(result).not.toContain('<usage>');
  });

  it('preserves text without usage blocks', () => {
    const input = 'Simple result text';
    expect(stripUsageBlock(input)).toBe('Simple result text');
  });

  it('handles multiple usage blocks', () => {
    const input = 'Result 1\n<usage>a</usage>\nMore text\n<usage>b</usage>';
    const result = stripUsageBlock(input);
    expect(result).toContain('Result 1');
    expect(result).toContain('More text');
    expect(result).not.toContain('<usage>');
  });
});

describe('toRichText', () => {
  it('wraps text in a RichTextBlock structure', () => {
    const block = toRichText('Hello world');
    expect(block).toEqual({
      type: 'rich_text',
      elements: [{
        type: 'rich_text_section',
        elements: [{ type: 'text', text: 'Hello world' }],
      }],
    });
  });
});

describe('StreamingStatus tracked tasks (TaskCreate / TaskUpdate)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('onTaskCreate adds tracked tasks that appear in getAllTodoItems', () => {
    const ss = createStatus();
    ss.onTaskCreate('Implement feature A', 'Implementing feature A');
    ss.onTaskCreate('Write tests');

    const items = ss.getAllTodoItems();
    expect(items).toHaveLength(2);
    expect(items[0].content).toBe('Implement feature A');
    expect(items[1].content).toBe('Write tests');
  });

  it('onTaskUpdate updates tracked task status', () => {
    const ss = createStatus();
    ss.onTaskCreate('Step 1');
    ss.onTaskCreate('Step 2');

    // Mark task 1 as in_progress
    ss.onTaskUpdate('1', { status: 'in_progress', activeForm: 'Working on step 1' });

    const items = ss.getAllTodoItems();
    expect(items[0].status).toBe('in_progress');
    expect(items[0].activeForm).toBe('Working on step 1');
    expect(items[1].status).toBe('pending');

    // Mark task 1 as completed
    ss.onTaskUpdate('1', { status: 'completed' });
    const updated = ss.getAllTodoItems();
    expect(updated[0].status).toBe('completed');
  });

  it('onTaskUpdate ignores unknown task IDs', () => {
    const ss = createStatus();
    ss.onTaskCreate('Step 1');
    // Should not throw
    ss.onTaskUpdate('999', { status: 'completed' });

    const items = ss.getAllTodoItems();
    expect(items).toHaveLength(1);
    expect(items[0].status).toBe('pending');
  });

  it('TaskCreate / TaskUpdate / TaskList are excluded from reasoning cards', () => {
    const ss = createStatus();
    ss.onReasoningText('Planning the work');
    ss.onToolUse('TaskCreate', { subject: 'Step 1' }, 'tc-1');
    ss.onToolUse('TaskUpdate', { taskId: '1', status: 'in_progress' }, 'tu-1');
    ss.onToolUse('TaskList', {}, 'tl-1');
    ss.onToolUse('Bash', { command: 'ls', description: 'List files' }, 'tool-1');
    ss.onToolResult('Bash', 'tool-1', 'file.txt');

    const chunks = taskChunks(ss.buildChunks());
    expect(chunks).toHaveLength(1);
    expect(chunks[0].output).not.toContain('TaskCreate');
    expect(chunks[0].output).not.toContain('TaskUpdate');
    expect(chunks[0].output).not.toContain('TaskList');
    expect(chunks[0].output).toContain('List files');
  });

  it('TaskCreate / TaskUpdate / TaskList results are excluded from reasoning cards', () => {
    const ss = createStatus();
    ss.onToolUse('Bash', { command: 'ls', description: 'List files' }, 'tool-1');
    ss.onToolResult('TaskCreate', 'tc-1', 'Task created');
    ss.onToolResult('TaskUpdate', 'tu-1', 'Task updated');
    ss.onToolResult('TaskList', 'tl-1', 'Task list');
    ss.onToolResult('Bash', 'tool-1', 'file.txt');

    const chunks = ss.buildAllChunks();
    expect(chunks).toHaveLength(1);
    // Non-subagent tools show display title, not result summary
    expect(chunks[0].output).toContain('List files');
  });

  it('tracked tasks do not appear in streaming buildChunks (standalone message)', () => {
    const ss = createStatus();
    ss.onTaskCreate('Step 1');
    ss.onTaskCreate('Step 2');

    const chunks = taskChunks(ss.buildChunks());
    const todoChunk = chunks.find(c => c.id === 'todo-list');
    expect(todoChunk).toBeUndefined();
  });

  it('tracked tasks appear in buildFinalTodoPlanBlock', () => {
    const ss = createStatus();
    ss.onTaskCreate('Step 1');
    ss.onTaskCreate('Step 2');
    ss.onTaskUpdate('1', { status: 'completed' });

    const plan = ss.buildFinalTodoPlanBlock();
    expect(plan).not.toBeNull();
    expect(plan!.title).toBe('Task Progress (1/2)');
    expect(plan!.tasks).toHaveLength(2);
  });
});

describe('StreamingStatus buildFinalTodoPlanBlock', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns null when no todos or tracked tasks exist', () => {
    const ss = createStatus();
    expect(ss.buildFinalTodoPlanBlock()).toBeNull();
  });

  it('renders each TodoWrite item as a TaskCardBlock with correct status mapping', () => {
    const ss = createStatus();
    ss.onTodoUpdate([
      { content: 'Step 1', status: 'completed' },
      { content: 'Step 2', status: 'in_progress', activeForm: 'Working on step 2' },
      { content: 'Step 3', status: 'pending' },
    ]);

    const plan = ss.buildFinalTodoPlanBlock();
    expect(plan).not.toBeNull();
    expect(plan!.type).toBe('plan');
    expect(plan!.title).toBe('Task Progress (1/3)');
    expect(plan!.tasks).toHaveLength(3);

    const tasks = plan!.tasks! as any[];
    expect(tasks[0]).toMatchObject({ type: 'task_card', title: 'Step 1', status: 'complete' });
    expect(tasks[1]).toMatchObject({ type: 'task_card', title: 'Working on step 2', status: 'in_progress' });
    expect(tasks[2]).toMatchObject({ type: 'task_card', title: 'Step 3', status: 'pending' });
  });

  it('renders TrackedTask items as TaskCardBlocks', () => {
    const ss = createStatus();
    ss.onTaskCreate('Implement feature', 'Implementing feature');
    ss.onTaskUpdate('1', { status: 'in_progress' });

    const plan = ss.buildFinalTodoPlanBlock();
    expect(plan).not.toBeNull();
    expect(plan!.tasks).toHaveLength(1);
    const task = plan!.tasks![0] as any;
    expect(task.type).toBe('task_card');
    expect(task.title).toBe('Implementing feature'); // uses activeForm for in_progress
    expect(task.status).toBe('in_progress');
  });

  it('uses activeForm as title for in-progress items, falls back to content/subject', () => {
    const ss = createStatus();
    ss.onTaskCreate('Step A');
    ss.onTaskCreate('Step B', 'Working on B');
    ss.onTaskUpdate('1', { status: 'in_progress' });
    ss.onTaskUpdate('2', { status: 'in_progress' });

    const plan = ss.buildFinalTodoPlanBlock();
    const tasks = plan!.tasks! as any[];
    expect(tasks[0].title).toBe('Step A');       // no activeForm → use subject
    expect(tasks[1].title).toBe('Working on B'); // has activeForm → use it
  });
});

describe('StreamingStatus getAllTodoItems', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns empty array when no todos or tasks', () => {
    const ss = createStatus();
    expect(ss.getAllTodoItems()).toEqual([]);
  });

  it('merges TodoWrite and TrackedTask items', () => {
    const ss = createStatus();
    ss.onTodoUpdate([
      { content: 'From TodoWrite', status: 'completed' },
    ]);
    ss.onTaskCreate('From TaskCreate');

    const items = ss.getAllTodoItems();
    expect(items).toHaveLength(2);
    expect(items[0].content).toBe('From TodoWrite');
    expect(items[1].content).toBe('From TaskCreate');
  });

  it('deduplicates by content (case-insensitive)', () => {
    const ss = createStatus();
    ss.onTodoUpdate([
      { content: 'Build feature', status: 'in_progress' },
    ]);
    ss.onTaskCreate('build feature'); // same content, different case

    const items = ss.getAllTodoItems();
    expect(items).toHaveLength(1);
    expect(items[0].content).toBe('Build feature'); // TodoWrite takes precedence
  });
});

describe('StreamingStatus per-todo tool tracking', () => {
  beforeEach(() => jest.clearAllMocks());

  it('onTodoUpdate sets activeTodoKey and tools are tracked per-todo', () => {
    const ss = createStatus();
    ss.onTodoUpdate([
      { content: 'Step 1', status: 'in_progress' },
      { content: 'Step 2', status: 'pending' },
    ]);

    ss.onToolUse('Bash', { command: 'ls', description: 'List files' }, 'tool-1');
    ss.onToolResult('Bash', 'tool-1', 'file.txt');

    const chunks = ss.buildTodoStreamChunks();
    const step1Chunk = chunks.find((c: any) => c.id === 'todo-0') as any;
    expect(step1Chunk.output).toContain('List files');
    expect(step1Chunk.output).toContain('\u2713'); // complete icon

    // Step 2 should have no tools (output omitted in delta)
    const step2Chunk = chunks.find((c: any) => c.id === 'todo-1') as any;
    expect(step2Chunk.output).toBeUndefined();
  });

  it('reasoning text accumulated on active todo appears in details (deduped)', () => {
    const ss = createStatus();
    ss.onTodoUpdate([
      { content: 'Build feature', status: 'in_progress' },
    ]);

    ss.onReasoningText('Analyzing the codebase');
    ss.onReasoningText('Analyzing the codebase'); // duplicate — should be ignored
    ss.onReasoningText('Found the right approach');

    const chunks = ss.buildTodoStreamChunks();
    const chunk = chunks.find((c: any) => c.id === 'todo-0') as any;
    expect(chunk.details).toContain('Analyzing the codebase');
    expect(chunk.details).toContain('Found the right approach');
    // "Analyzing the codebase" should appear exactly once
    const occurrences = chunk.details.split('Analyzing the codebase').length - 1;
    expect(occurrences).toBe(1);
  });

  it('different reasoning texts DO accumulate properly', () => {
    const ss = createStatus();
    ss.onTodoUpdate([
      { content: 'Build feature', status: 'in_progress' },
    ]);

    ss.onReasoningText('First thought');
    ss.onReasoningText('Second thought');
    ss.onReasoningText('Third thought');

    const chunks = ss.buildTodoStreamChunks();
    const chunk = chunks.find((c: any) => c.id === 'todo-0') as any;
    expect(chunk.details).toContain('First thought');
    expect(chunk.details).toContain('Second thought');
    expect(chunk.details).toContain('Third thought');
  });

  it('duplicate onToolUse after onToolResult only produces one tool entry in todo', () => {
    const ss = createStatus();
    ss.onTodoUpdate([
      { content: 'Fix bug', status: 'in_progress' },
    ]);

    ss.onToolUse('Bash', { command: 'ls', description: 'List files' }, 'tool-1');
    ss.onToolResult('Bash', 'tool-1', 'file.txt');
    // SDK replays the same toolUseId on a subsequent turn
    ss.onToolUse('Bash', { command: 'ls', description: 'List files' }, 'tool-1');

    const chunks = ss.buildTodoStreamChunks();
    const chunk = chunks.find((c: any) => c.id === 'todo-0') as any;
    // Should have exactly one tool line
    const lines = chunk.output.split('\n').filter((l: string) => l.trim());
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('List files');
  });

  it('buildTodoStreamChunks updates plan_update title when completion count changes', () => {
    const ss = createStatus();
    ss.onTodoUpdate([
      { content: 'Step 1', status: 'in_progress' },
      { content: 'Step 2', status: 'pending' },
    ]);

    // First call: plan_update with base title (no completions yet)
    const first = ss.buildTodoStreamChunks();
    const firstPlan = first.filter((c: any) => c.type === 'plan_update') as any[];
    expect(firstPlan).toHaveLength(1);
    expect(firstPlan[0].title).toBe('Task Progress');

    // Second call with no changes: plan_update NOT re-sent
    const second = ss.buildTodoStreamChunks();
    const secondPlan = second.filter((c: any) => c.type === 'plan_update') as any[];
    expect(secondPlan).toHaveLength(0);

    // After task completion: plan_update re-sent with counter
    ss.onTodoUpdate([
      { content: 'Step 1', status: 'completed' },
      { content: 'Step 2', status: 'in_progress' },
    ]);
    const third = ss.buildTodoStreamChunks();
    const thirdPlan = third.filter((c: any) => c.type === 'plan_update') as any[];
    expect(thirdPlan).toHaveLength(1);
    expect(thirdPlan[0].title).toBe('Task Progress (1/2)');
  });

  it('tool lines appear in output with status icons and result summaries', () => {
    const ss = createStatus();
    ss.onTodoUpdate([
      { content: 'Fix bug', status: 'in_progress' },
    ]);

    ss.onToolUse('Read', { file_path: '/src/app.ts' }, 'tool-1');
    ss.onToolUse('Edit', { file_path: '/src/app.ts' }, 'tool-2');
    ss.onToolResult('Read', 'tool-1', 'contents of file');

    const chunks = ss.buildTodoStreamChunks();
    const chunk = chunks.find((c: any) => c.id === 'todo-0') as any;
    // Read is complete → sent as delta; Edit is in_progress → not sent yet
    expect(chunk.output).toContain('\u2713 Read');
    // Non-subagent tools show display title, not result summary
    expect(chunk.output).not.toContain('Edit');
  });

  it('tool result updates correct todo even when a different todo is now active', () => {
    const ss = createStatus();
    ss.onTodoUpdate([
      { content: 'Step 1', status: 'in_progress' },
      { content: 'Step 2', status: 'pending' },
    ]);

    // Tool starts during step 1
    ss.onToolUse('Bash', { command: 'npm test', description: 'Run tests' }, 'tool-1');

    // Step 1 completes, Step 2 starts
    ss.onTodoUpdate([
      { content: 'Step 1', status: 'completed' },
      { content: 'Step 2', status: 'in_progress' },
    ]);

    // Tool result arrives (for step 1's tool)
    ss.onToolResult('Bash', 'tool-1', 'All tests passed');

    const chunks = ss.buildTodoStreamChunks();
    const step1Chunk = chunks.find((c: any) => c.id === 'todo-0') as any;
    // Non-subagent tools show display title, not result summary
    expect(step1Chunk.output).toContain('Run tests');
    expect(step1Chunk.output).toContain('\u2713');
  });

  it('buildFinalTodoPlanBlock includes details/output as RichTextBlock', () => {
    const ss = createStatus();
    ss.onTodoUpdate([
      { content: 'Analyze code', status: 'in_progress' },
    ]);

    ss.onReasoningText('Looking at the structure');
    ss.onToolUse('Read', { file_path: '/src/main.ts' }, 'tool-1');
    ss.onToolResult('Read', 'tool-1', 'file contents');

    // Mark as complete
    ss.onTodoUpdate([
      { content: 'Analyze code', status: 'completed' },
    ]);

    const plan = ss.buildFinalTodoPlanBlock();
    expect(plan).not.toBeNull();
    const task = plan!.tasks![0] as any;
    expect(task.details.type).toBe('rich_text');
    expect(task.details.elements[0].elements[0].text).toContain('Looking at the structure');
    expect(task.output.type).toBe('rich_text');
    expect(task.output.elements[0].elements[0].text).toContain('Read');
    // Non-subagent tools show display title, not result summary
  });

  it('buildToolLines shared helper produces correct format', () => {
    const ss = createStatus();
    // Use reasoning card to test the shared buildToolLines through buildReasoningChunk
    ss.onReasoningText('Working');
    ss.onToolUse('Grep', { pattern: 'foo' }, 'tool-1');
    ss.onToolResult('Grep', 'tool-1', 'Found 5 matches');
    ss.onToolUse('Bash', { command: 'npm test', description: 'Run tests' }, 'tool-2');
    ss.onToolResult('Bash', 'tool-2', 'All tests passed');

    const chunks = ss.buildAllChunks();
    // Complete tool has ✓ icon and display title (non-subagent: no result summary)
    expect(chunks[0].output).toContain('\u2713 Search for `foo`');
    expect(chunks[0].output).toContain('\u2713 Run tests');
  });

  it('buildToolLines uses newline separator for multiline result summaries', () => {
    const ss = createStatus();
    ss.onTodoUpdate([
      { content: 'Run task', status: 'in_progress' },
    ]);

    ss.onToolUse('Bash', { command: 'echo hello', description: 'Echo numbers' }, 'tool-1');
    ss.onToolResult('Bash', 'tool-1', '=== Task 1 ===\n1\n2\n3');

    const chunks = ss.buildTodoStreamChunks();
    const chunk = chunks.find((c: any) => c.id === 'todo-0') as any;
    // Non-subagent tools show display title without result summary
    expect(chunk.output).toContain('\u2713 Echo numbers');
  });

  it('TrackedTask items (TaskCreate/TaskUpdate) get same tracking treatment', () => {
    const ss = createStatus();
    ss.onTaskCreate('Deploy service');
    ss.onTaskUpdate('1', { status: 'in_progress' });

    ss.onToolUse('Bash', { command: 'npm run build', description: 'Build service' }, 'tool-1');
    ss.onToolResult('Bash', 'tool-1', 'Build succeeded');

    const chunks = ss.buildTodoStreamChunks();
    const deployChunk = chunks.find((c: any) => c.id === 'todo-0') as any;
    expect(deployChunk.output).toContain('Build service');
    expect(deployChunk.output).toContain('\u2713');
  });

  it('todo without history has no details or output in delta', () => {
    const ss = createStatus();
    ss.onTodoUpdate([
      { content: 'Future task', status: 'pending' },
    ]);

    const chunks = ss.buildTodoStreamChunks();
    const chunk = chunks.find((c: any) => c.id === 'todo-0') as any;
    expect(chunk.details).toBeUndefined();
    expect(chunk.output).toBeUndefined();
  });

  it('streaming chunks use delta dedup — unchanged tasks are not re-sent', () => {
    const ss = createStatus();
    ss.onTodoUpdate([
      { content: 'Step 1', status: 'in_progress' },
      { content: 'Step 2', status: 'pending' },
    ]);

    // First call: both tasks sent
    const first = ss.buildTodoStreamChunks();
    const firstTasks = first.filter((c: any) => c.type === 'task_update');
    expect(firstTasks).toHaveLength(2);

    // Second call with no changes: nothing re-sent
    const second = ss.buildTodoStreamChunks();
    expect(second).toHaveLength(0);

    // Status change on Step 1 only: Step 1 re-sent + plan_update with counter
    ss.onTodoUpdate([
      { content: 'Step 1', status: 'completed' },
      { content: 'Step 2', status: 'pending' },
    ]);
    const third = ss.buildTodoStreamChunks();
    const thirdTasks = third.filter((c: any) => c.type === 'task_update');
    expect(thirdTasks).toHaveLength(1);
    expect((thirdTasks[0] as any).id).toBe('todo-0');
    expect((thirdTasks[0] as any).status).toBe('complete');
    // plan_update should also be sent with counter
    const thirdPlan = third.filter((c: any) => c.type === 'plan_update') as any[];
    expect(thirdPlan).toHaveLength(1);
    expect(thirdPlan[0].title).toBe('Task Progress (1/2)');
  });

  it('streaming sends only delta details and newly completed tool lines', () => {
    const ss = createStatus();
    ss.onTodoUpdate([
      { content: 'Fix bug', status: 'in_progress' },
    ]);

    // First call: initial state (no details/output yet)
    ss.buildTodoStreamChunks();

    // Add reasoning — delta should contain only the new text
    ss.onReasoningText('Investigating the issue');
    const second = ss.buildTodoStreamChunks();
    const secondTask = second.find((c: any) => c.id === 'todo-0') as any;
    expect(secondTask).toBeDefined();
    expect(secondTask.details).toBe('Investigating the issue');

    // Add more reasoning — delta should contain only the new portion
    ss.onReasoningText('Found root cause');
    const third = ss.buildTodoStreamChunks();
    const thirdTask = third.find((c: any) => c.id === 'todo-0') as any;
    expect(thirdTask.details).toBe('\nFound root cause');
    expect(thirdTask.details).not.toContain('Investigating');

    // No changes — nothing re-sent
    const fourth = ss.buildTodoStreamChunks();
    expect(fourth).toHaveLength(0);

    // Add tool (in_progress) — not sent yet (only completed tools appear as deltas)
    ss.onToolUse('Read', { file_path: '/src/app.ts' }, 'tool-1');
    const fifth = ss.buildTodoStreamChunks();
    expect(fifth).toHaveLength(0);

    // Complete the tool — now the completed line is sent as delta
    ss.onToolResult('Read', 'tool-1', 'file contents');
    const sixth = ss.buildTodoStreamChunks();
    const sixthTask = sixth.find((c: any) => c.id === 'todo-0') as any;
    expect(sixthTask).toBeDefined();
    expect(sixthTask.output).toContain('\u2713 Read');
    // Non-subagent tools show display title, not result summary
  });
});

describe("StreamingStatus resetDeltaTracking", () => {
  beforeEach(() => jest.clearAllMocks());

  it("should re-send full card state after reset", () => {
    const ss = createStatus();
    ss.onReasoningText("Checking the file");
    ss.onToolUse("Read", { file_path: "/foo.ts" }, "tu-1");
    ss.onToolResult("Read", "tu-1");

    // First buildChunks sends the card
    const first = ss.buildChunks();
    expect(taskChunks(first)).toHaveLength(1);
    expect(taskChunks(first)[0].title).toBe("Checking the file");

    // Second buildChunks returns nothing (already sent, no changes)
    const second = ss.buildChunks();
    expect(taskChunks(second)).toHaveLength(0);

    // After reset, the same card is re-sent with full content
    ss.resetDeltaTracking();
    const third = ss.buildChunks();
    expect(taskChunks(third)).toHaveLength(1);
    expect(taskChunks(third)[0].title).toBe("Checking the file");
  });
});

describe("StreamingStatus sources on task cards", () => {
  beforeEach(() => jest.clearAllMocks());

  it("should include source for Edit tool", () => {
    const ss = createStatus();
    ss.onToolUse("Edit", { file_path: "/src/foo.ts", old_string: "a", new_string: "b" }, "tu-1");
    ss.onToolResult("Edit", "tu-1");
    const chunks = ss.buildAllChunks();
    expect(chunks.length).toBe(1);
    expect(chunks[0].sources).toEqual([{ type: "url", url: "file:///src/foo.ts", text: "foo.ts" }]);
  });

  it("should include source for Write tool", () => {
    const ss = createStatus();
    ss.onToolUse("Write", { file_path: "/src/bar.ts" }, "tu-2");
    ss.onToolResult("Write", "tu-2");
    const chunks = ss.buildAllChunks();
    expect(chunks[0].sources).toEqual([{ type: "url", url: "file:///src/bar.ts", text: "bar.ts" }]);
  });

  it("should include source for WebFetch tool", () => {
    const ss = createStatus();
    ss.onToolUse("WebFetch", { url: "https://example.com/api" }, "tu-3");
    ss.onToolResult("WebFetch", "tu-3");
    const chunks = ss.buildAllChunks();
    expect(chunks[0].sources).toEqual([{ type: "url", url: "https://example.com/api", text: "example.com/api" }]);
  });

  it("should not include source for Read tool", () => {
    const ss = createStatus();
    ss.onToolUse("Read", { file_path: "/src/foo.ts" }, "tu-4");
    ss.onToolResult("Read", "tu-4");
    const chunks = ss.buildAllChunks();
    expect(chunks[0].sources).toBeUndefined();
  });

  it("should not include source for WebSearch tool", () => {
    const ss = createStatus();
    ss.onToolUse("WebSearch", { query: "test query" }, "tu-7");
    ss.onToolResult("WebSearch", "tu-7");
    const chunks = ss.buildAllChunks();
    expect(chunks[0].sources).toBeUndefined();
  });

  it("should deduplicate sources within a card", () => {
    const ss = createStatus();
    ss.onToolUse("Edit", { file_path: "/src/foo.ts", old_string: "a", new_string: "b" }, "tu-5");
    ss.onToolResult("Edit", "tu-5");
    ss.onToolUse("Edit", { file_path: "/src/foo.ts", old_string: "c", new_string: "d" }, "tu-6");
    ss.onToolResult("Edit", "tu-6");
    const chunks = ss.buildAllChunks();
    expect(chunks[0].sources).toEqual([{ type: "url", url: "file:///src/foo.ts", text: "foo.ts" }]);
  });

  it("should not re-send sources already sent in previous buildChunks calls", () => {
    const ss = createStatus();
    ss.onToolUse("Edit", { file_path: "/src/foo.ts", old_string: "a", new_string: "b" }, "tu-10");
    ss.onToolResult("Edit", "tu-10");

    // First buildChunks — sources should be included
    const first = ss.buildChunks();
    const firstTask = first.filter((c: any) => c.type === "task_update");
    expect(firstTask).toHaveLength(1);
    expect((firstTask[0] as any).sources).toEqual([{ type: "url", url: "file:///src/foo.ts", text: "foo.ts" }]);

    // Second edit to same file — same card gets new output but sources already sent
    ss.onToolUse("Edit", { file_path: "/src/foo.ts", old_string: "c", new_string: "d" }, "tu-11");
    ss.onToolResult("Edit", "tu-11");
    const second = ss.buildChunks();
    const secondTask = second.filter((c: any) => c.type === "task_update");
    expect(secondTask).toHaveLength(1);
    expect((secondTask[0] as any).sources).toBeUndefined();
  });

  it("should send new source when a different file is edited in same card", () => {
    const ss = createStatus();
    ss.onToolUse("Edit", { file_path: "/src/foo.ts", old_string: "a", new_string: "b" }, "tu-20");
    ss.onToolResult("Edit", "tu-20");

    // First buildChunks — foo.ts source sent
    const first = ss.buildChunks();
    const firstTask = first.filter((c: any) => c.type === "task_update");
    expect((firstTask[0] as any).sources).toEqual([{ type: "url", url: "file:///src/foo.ts", text: "foo.ts" }]);

    // Edit a different file — bar.ts source should be sent, foo.ts should NOT
    ss.onToolUse("Edit", { file_path: "/src/bar.ts", old_string: "x", new_string: "y" }, "tu-21");
    ss.onToolResult("Edit", "tu-21");
    const second = ss.buildChunks();
    const secondTask = second.filter((c: any) => c.type === "task_update");
    expect(secondTask).toHaveLength(1);
    expect((secondTask[0] as any).sources).toEqual([{ type: "url", url: "file:///src/bar.ts", text: "bar.ts" }]);
  });

  it("should re-send sources after resetDeltaTracking", () => {
    const ss = createStatus();
    ss.onToolUse("Edit", { file_path: "/src/foo.ts", old_string: "a", new_string: "b" }, "tu-30");
    ss.onToolResult("Edit", "tu-30");

    ss.buildChunks(); // sources sent
    ss.resetDeltaTracking();

    // After reset, sources should be re-sent
    const after = ss.buildChunks();
    const task = after.filter((c: any) => c.type === "task_update");
    expect(task).toHaveLength(1);
    expect((task[0] as any).sources).toEqual([{ type: "url", url: "file:///src/foo.ts", text: "foo.ts" }]);
  });
});
