// tests/unit/services/progress-tracker.test.ts
import { ProgressTracker } from '../../../src/services/progress-tracker';
import type { TodoItem } from '../../../src/types';
import type { TaskUpdateChunk, PlanUpdateChunk } from '@slack/types';

describe('ProgressTracker', () => {
  let tracker: ProgressTracker;

  beforeEach(() => {
    tracker = new ProgressTracker();
  });

  // ── Card creation via onToolUse ─────────────────────────────────

  describe('onToolUse / buildMainChunks', () => {
    it('creates a card entry and buildChunks returns it', () => {
      tracker.onToolUse('Read', { file_path: '/src/index.ts' }, 'tu-1');

      const chunks = tracker.buildMainChunks();
      expect(chunks.length).toBeGreaterThanOrEqual(1);

      const taskChunk = chunks.find(
        (c): c is TaskUpdateChunk => c.type === 'task_update',
      );
      expect(taskChunk).toBeDefined();
      expect(taskChunk!.status).toBe('in_progress');
      expect(taskChunk!.title).toBeTruthy();
    });

    it('deduplicates same toolUseId', () => {
      tracker.onToolUse('Read', { file_path: '/a.ts' }, 'tu-dup');
      tracker.onToolUse('Read', { file_path: '/a.ts' }, 'tu-dup');

      const chunks = tracker.buildMainChunks();
      const taskChunks = chunks.filter(c => c.type === 'task_update') as TaskUpdateChunk[];
      // Should have exactly one card
      expect(taskChunks).toHaveLength(1);
    });

    it('skips TodoWrite, TaskCreate, TaskUpdate, TaskList tools', () => {
      tracker.onToolUse('TodoWrite', {}, 'tu-tw');
      tracker.onToolUse('TaskCreate', {}, 'tu-tc');
      tracker.onToolUse('TaskUpdate', {}, 'tu-tup');
      tracker.onToolUse('TaskList', {}, 'tu-tl');

      const chunks = tracker.buildMainChunks();
      expect(chunks.filter(c => c.type === 'task_update')).toHaveLength(0);
    });

    it('groups multiple tools into the same card', () => {
      tracker.onToolUse('Read', { file_path: '/a.ts' }, 'tu-1');
      tracker.onToolUse('Edit', { file_path: '/a.ts' }, 'tu-2');

      const chunks = tracker.buildMainChunks();
      const taskChunks = chunks.filter(c => c.type === 'task_update') as TaskUpdateChunk[];
      // Both tools should be in the same card
      expect(taskChunks).toHaveLength(1);
    });

    it('creates a new card after finalizeCurrentCard()', () => {
      tracker.onToolUse('Read', { file_path: '/a.ts' }, 'tu-1');
      tracker.finalizeCurrentCard();
      tracker.onToolUse('Edit', { file_path: '/b.ts' }, 'tu-2');

      const chunks = tracker.buildMainChunks();
      const taskChunks = chunks.filter(c => c.type === 'task_update') as TaskUpdateChunk[];
      expect(taskChunks).toHaveLength(2);
    });

    it('uses pending reasoning as card title', () => {
      tracker.onReasoningText('Looking at the configuration file');
      tracker.onToolUse('Read', { file_path: '/config.ts' }, 'tu-1');

      const chunks = tracker.buildMainChunks();
      const taskChunk = chunks.find(
        (c): c is TaskUpdateChunk => c.type === 'task_update',
      )!;
      expect(taskChunk.title).toContain('Looking at the configuration file');
    });

    it('uses fallback title when no reasoning text', () => {
      tracker.onToolUse('Read', { file_path: '/src/index.ts' }, 'tu-1');

      const chunks = tracker.buildMainChunks();
      const taskChunk = chunks.find(
        (c): c is TaskUpdateChunk => c.type === 'task_update',
      )!;
      expect(taskChunk.title).toBe('Reading files');
    });

    it('creates a dedicated subagent card for Agent tool', () => {
      tracker.onToolUse('Read', { file_path: '/a.ts' }, 'tu-1');
      tracker.onToolUse('Agent', { description: 'Fix the bug' }, 'tu-task');

      const chunks = tracker.buildMainChunks();
      const taskChunks = chunks.filter(c => c.type === 'task_update') as TaskUpdateChunk[];
      // Two cards: one for Read, one for the Task subagent
      expect(taskChunks).toHaveLength(2);
    });

    it('attaches file source for Edit tool', () => {
      tracker.onToolUse('Edit', { file_path: '/src/app.ts', old_string: 'a', new_string: 'b' }, 'tu-edit');
      tracker.onToolResult('Edit', 'tu-edit', 'done');

      const chunks = tracker.buildMainChunks();
      const taskChunk = chunks.find(
        (c): c is TaskUpdateChunk => c.type === 'task_update',
      )!;
      // sources should contain the file URL
      expect(taskChunk.sources).toBeDefined();
      expect(taskChunk.sources![0].url).toMatch(/\/src\/app\.ts$/);
    });

    it('attaches URL source for WebFetch tool', () => {
      tracker.onToolUse('WebFetch', { url: 'https://example.com/api/data' }, 'tu-wf');
      tracker.onToolResult('WebFetch', 'tu-wf', 'fetched');

      const chunks = tracker.buildMainChunks();
      const taskChunk = chunks.find(
        (c): c is TaskUpdateChunk => c.type === 'task_update',
      )!;
      expect(taskChunk.sources).toBeDefined();
      expect(taskChunk.sources![0].url).toBe('https://example.com/api/data');
    });
  });

  // ── Tool result ────────────────────────────────────────────────

  describe('onToolResult', () => {
    it('marks a tool as complete in the card', () => {
      tracker.onToolUse('Bash', { command: 'ls' }, 'tu-bash');
      tracker.onToolResult('Bash', 'tu-bash', 'file1.ts\nfile2.ts');

      const chunks = tracker.buildMainChunks();
      const taskChunk = chunks.find(
        (c): c is TaskUpdateChunk => c.type === 'task_update',
      )!;
      // Output should contain completed tool line
      expect(taskChunk.output).toContain('\u2713');
    });

    it('deduplicates same tool result id', () => {
      tracker.onToolUse('Read', { file_path: '/a.ts' }, 'tu-r1');
      tracker.onToolResult('Read', 'tu-r1', 'content');
      tracker.onToolResult('Read', 'tu-r1', 'content');

      // Should not throw; second call is simply ignored
      const chunks = tracker.buildMainChunks();
      expect(chunks.length).toBeGreaterThanOrEqual(1);
    });

    it('completes a subagent card', () => {
      tracker.onToolUse('Agent', { description: 'Run tests' }, 'tu-task');
      tracker.onToolResult('Agent', 'tu-task', 'Tests passed\n<usage>tool_uses: 5\nduration_ms: 12000</usage>');

      const chunks = tracker.buildMainChunks();
      const taskChunk = chunks.find(
        (c): c is TaskUpdateChunk => c.type === 'task_update',
      )!;
      expect(taskChunk.status).toBe('complete');
    });
  });

  // ── Todo tracking ─────────────────────────────────────────────

  describe('onTodoUpdate / buildTodoStreamChunks', () => {
    it('stores todos and buildTodoStreamChunks returns them', () => {
      const todos: TodoItem[] = [
        { content: 'Write tests', status: 'completed' },
        { content: 'Implement feature', status: 'in_progress' },
        { content: 'Deploy', status: 'pending' },
      ];
      tracker.onTodoUpdate(todos);

      const chunks = tracker.buildTodoStreamChunks();
      expect(chunks.length).toBeGreaterThan(0);

      // Should include a plan_update chunk with task progress
      const planChunk = chunks.find(
        (c): c is PlanUpdateChunk => c.type === 'plan_update',
      );
      expect(planChunk).toBeDefined();
      expect(planChunk!.title).toContain('Task Progress');

      // Should include task_update chunks for each todo
      const taskChunks = chunks.filter(c => c.type === 'task_update') as TaskUpdateChunk[];
      expect(taskChunks).toHaveLength(3);
    });

    it('shows completion count in plan title', () => {
      const todos: TodoItem[] = [
        { content: 'A', status: 'completed' },
        { content: 'B', status: 'completed' },
        { content: 'C', status: 'pending' },
      ];
      tracker.onTodoUpdate(todos);

      const chunks = tracker.buildTodoStreamChunks();
      const planChunk = chunks.find(
        (c): c is PlanUpdateChunk => c.type === 'plan_update',
      );
      expect(planChunk!.title).toBe('Task Progress (2/3)');
    });

    it('returns empty when no todos', () => {
      const chunks = tracker.buildTodoStreamChunks();
      expect(chunks).toHaveLength(0);
    });

    it('deduplicates duplicate content within todoCard, last occurrence wins', () => {
      const todos: TodoItem[] = [
        { content: 'Pop stash with local changes', status: 'completed' },
        { content: 'Pop stash with local changes', status: 'in_progress' },
      ];
      tracker.onTodoUpdate(todos);

      const items = tracker.getAllTodoItems();
      expect(items).toHaveLength(1);
      expect(items[0].status).toBe('in_progress');

      const chunks = tracker.buildTodoStreamChunks();
      const taskChunks = chunks.filter(c => c.type === 'task_update') as TaskUpdateChunk[];
      expect(taskChunks).toHaveLength(1);
    });

    it('last occurrence wins across todoCard and trackedTasks', () => {
      tracker.onTodoUpdate([{ content: 'Deploy app', status: 'completed' }]);
      tracker.onTaskCreate('Deploy app');
      tracker.onTaskUpdate('1', { status: 'in_progress' });

      const items = tracker.getAllTodoItems();
      expect(items).toHaveLength(1);
      expect(items[0].status).toBe('in_progress');
    });

    it('uses activeForm as title for in_progress items', () => {
      const todos: TodoItem[] = [
        { content: 'Build UI', status: 'in_progress', activeForm: 'Building the React UI' },
      ];
      tracker.onTodoUpdate(todos);

      const chunks = tracker.buildTodoStreamChunks();
      const taskChunk = chunks.find(
        (c): c is TaskUpdateChunk => c.type === 'task_update',
      )!;
      expect(taskChunk.title).toBe('Building the React UI');
    });

    it('hasTodoItems returns false when empty', () => {
      expect(tracker.hasTodoItems()).toBe(false);
    });

    it('hasTodoItems returns true when todos exist', () => {
      tracker.onTodoUpdate([{ content: 'A', status: 'pending' }]);
      expect(tracker.hasTodoItems()).toBe(true);
    });
  });

  // ── Thinking text ──────────────────────────────────────────────

  describe('buildThinkingText', () => {
    it('returns generic text when no tool has completed', () => {
      expect(tracker.buildThinkingText()).toBe('is thinking...');
    });

    it('returns contextual text after Read tool completes', () => {
      tracker.onToolUse('Read', { file_path: '/src/deep/nested/config.ts' }, 'tu-r');
      tracker.onToolResult('Read', 'tu-r', 'file content');

      const text = tracker.buildThinkingText();
      expect(text).toContain('analyzing');
      expect(text).toContain('config.ts');
    });

    it('returns contextual text after Edit tool completes', () => {
      tracker.onToolUse('Edit', { file_path: '/a.ts' }, 'tu-e');
      tracker.onToolResult('Edit', 'tu-e', 'ok');

      expect(tracker.buildThinkingText()).toContain('reviewing the changes');
    });

    it('returns contextual text after Bash tool completes', () => {
      tracker.onToolUse('Bash', { command: 'npm test' }, 'tu-b');
      tracker.onToolResult('Bash', 'tu-b', 'ok');

      expect(tracker.buildThinkingText()).toContain('reviewing the output');
    });

    it('returns contextual text after Grep tool completes', () => {
      tracker.onToolUse('Grep', { pattern: 'TODO' }, 'tu-g');
      tracker.onToolResult('Grep', 'tu-g', 'matches');

      expect(tracker.buildThinkingText()).toContain('reviewing search results');
    });

    it('returns contextual text after Agent tool completes', () => {
      tracker.onToolUse('Agent', { description: 'subtask' }, 'tu-t');
      tracker.onToolResult('Agent', 'tu-t', 'done');

      expect(tracker.buildThinkingText()).toContain('reviewing agent results');
    });

    it('returns contextual text after WebFetch/WebSearch completes', () => {
      tracker.onToolUse('WebFetch', { url: 'https://x.com' }, 'tu-wf');
      tracker.onToolResult('WebFetch', 'tu-wf', 'data');

      expect(tracker.buildThinkingText()).toContain('reviewing web results');
    });

    it('returns generic text after Write tool completes', () => {
      tracker.onToolUse('Write', { file_path: '/a.ts' }, 'tu-w');
      tracker.onToolResult('Write', 'tu-w', 'ok');

      expect(tracker.buildThinkingText()).toContain('reviewing the new file');
    });
  });

  // ── Typing text ────────────────────────────────────────────────

  describe('buildTypingText', () => {
    it('returns tool-specific text for Read', () => {
      const text = tracker.buildTypingText('Read', { file_path: '/deep/path/file.ts' });
      expect(text).toContain('reading');
      expect(text).toContain('file.ts');
    });

    it('returns tool-specific text for Edit', () => {
      const text = tracker.buildTypingText('Edit', { file_path: '/x.ts' });
      expect(text).toContain('editing');
    });

    it('returns tool-specific text for Bash with description', () => {
      const text = tracker.buildTypingText('Bash', { description: 'Install deps', command: 'npm i' });
      expect(text).toContain('running');
      expect(text).toContain('Install deps');
    });

    it('returns tool-specific text for Bash without description', () => {
      const text = tracker.buildTypingText('Bash', { command: 'npm test' });
      expect(text).toContain('running');
    });

    it('returns tool-specific text for Grep', () => {
      const text = tracker.buildTypingText('Grep', { pattern: 'foo.*bar' });
      expect(text).toContain('searching');
      expect(text).toContain('foo.*bar');
    });

    it('returns tool-specific text for Task', () => {
      const text = tracker.buildTypingText('Agent', { description: 'Fix auth bug' });
      expect(text).toContain('working on');
      expect(text).toContain('Fix auth bug');
    });

    it('includes elapsed time when >= 1s', () => {
      const text = tracker.buildTypingText('Read', { file_path: '/a.ts' }, 5);
      expect(text).toContain('(5s)');
    });

    it('omits elapsed time when < 1s', () => {
      const text = tracker.buildTypingText('Read', { file_path: '/a.ts' }, 0.5);
      expect(text).not.toContain('(');
    });

    it('returns generic text for unknown tools', () => {
      const text = tracker.buildTypingText('SomeCustomTool', {});
      expect(text).toContain('working');
    });

    it('returns tool-specific text for Skill', () => {
      const text = tracker.buildTypingText('Skill', { skill: 'commit' });
      expect(text).toContain('skill');
      expect(text).toContain('commit');
    });
  });

  // ── Compaction ─────────────────────────────────────────────────

  describe('onCompactionStatus', () => {
    it('sets compacting indicator and creates a card', () => {
      tracker.onCompactionStatus(true);

      const chunks = tracker.buildMainChunks();
      const taskChunk = chunks.find(
        (c): c is TaskUpdateChunk => c.type === 'task_update',
      );
      expect(taskChunk).toBeDefined();
      expect(taskChunk!.title).toContain('Compacting');
      expect(taskChunk!.status).toBe('in_progress');
    });

    it('completes compacting card on false', () => {
      tracker.onCompactionStatus(true);
      tracker.onCompactionStatus(false);

      const chunks = tracker.buildMainChunks();
      const taskChunks = chunks.filter(c => c.type === 'task_update') as TaskUpdateChunk[];
      expect(taskChunks).toHaveLength(1);
      expect(taskChunks[0].status).toBe('complete');
    });
  });

  // ── Finalize current card ──────────────────────────────────────

  describe('finalizeCurrentCard', () => {
    it('marks current card as complete', () => {
      tracker.onToolUse('Read', { file_path: '/a.ts' }, 'tu-1');
      tracker.finalizeCurrentCard();

      const chunks = tracker.buildMainChunks();
      const taskChunk = chunks.find(
        (c): c is TaskUpdateChunk => c.type === 'task_update',
      )!;
      expect(taskChunk.status).toBe('complete');
    });

    it('is safe to call when no current card', () => {
      // Should not throw
      tracker.finalizeCurrentCard();
    });
  });

  // ── Plan title ─────────────────────────────────────────────────

  describe('plan title', () => {
    it('setPlanTitle / getPlanTitle round-trips', () => {
      tracker.setPlanTitle('My Plan');
      expect(tracker.getPlanTitle()).toBe('My Plan');
    });

    it('buildChunks includes plan_update when title is set', () => {
      tracker.setPlanTitle('Build Feature');
      tracker.onToolUse('Read', { file_path: '/a.ts' }, 'tu-1');

      const chunks = tracker.buildMainChunks();
      const planChunk = chunks.find(
        (c): c is PlanUpdateChunk => c.type === 'plan_update',
      );
      expect(planChunk).toBeDefined();
      expect(planChunk!.title).toBe('Build Feature');
    });

    it('buildChunks does not include plan_update when title is empty', () => {
      tracker.onToolUse('Read', { file_path: '/a.ts' }, 'tu-1');

      const chunks = tracker.buildMainChunks();
      const planChunk = chunks.find(c => c.type === 'plan_update');
      expect(planChunk).toBeUndefined();
    });
  });

  // ── Task tracking (TaskCreate / TaskUpdate) ───────────────────

  describe('task tracking', () => {
    it('onTaskCreate adds a tracked task merged into getAllTodoItems', () => {
      tracker.onTaskCreate('Build the form');
      const items = tracker.getAllTodoItems();
      expect(items).toHaveLength(1);
      expect(items[0].content).toBe('Build the form');
      expect(items[0].status).toBe('pending');
    });

    it('onTaskUpdate updates tracked task status', () => {
      tracker.onTaskCreate('Build form');
      // TaskCreate assigns IDs starting at "1"
      tracker.onTaskUpdate('1', { status: 'in_progress' });
      const items = tracker.getAllTodoItems();
      expect(items[0].status).toBe('in_progress');
    });

    it('deduplicates tracked tasks against todo items by content', () => {
      tracker.onTodoUpdate([{ content: 'Build form', status: 'pending' }]);
      tracker.onTaskCreate('Build form');
      const items = tracker.getAllTodoItems();
      expect(items).toHaveLength(1); // deduped
    });
  });
});
