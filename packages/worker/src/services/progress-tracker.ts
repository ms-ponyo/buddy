// src/services/progress-tracker.ts — Progress tracking for reasoning cards, todos, and status text.
// Replaces src/streaming-status.ts (904 lines). Decomposed into CardManager, TodoManager, ThinkingTextBuilder.
// No adapter dependencies — only builds data structures. Gateway owns stream lifecycle.

import type { AnyChunk, TaskUpdateChunk, PlanUpdateChunk, URLSourceElement } from '@slack/types';
import type { RichTextBlock, TaskCardBlock, PlanBlock } from '@slack/types';
import type { TodoItem } from '../types.js';
import { formatDiffMarkdownEx, formatFileCreateMarkdown, formatFullDiff } from '../util/diff-formatter.js';
import { getTunnelStatus } from '../mcp-servers/vscode-tunnel-server.js';

let cachedTunnelName: string | null | undefined;

function getTunnelName(): string | null {
  if (cachedTunnelName !== undefined) return cachedTunnelName;
  const status = getTunnelStatus();
  cachedTunnelName = status.tunnel?.name ?? null;
  return cachedTunnelName;
}

let _projectDir: string | undefined;

function fileSource(fp: string): { url: string; text: string } {
  const tunnel = getTunnelName();
  if (tunnel && _projectDir) {
    const rel = fp.startsWith(_projectDir) ? fp.slice(_projectDir.length + 1) : fp;
    return { url: `https://vscode.dev/tunnel/${tunnel}${_projectDir}`, text: rel };
  }
  const fileName = fp.split('/').pop() ?? fp;
  return { url: `file://${fp}`, text: fileName };
}

// ── Internal types ──────────────────────────────────────────────────

interface ToolEntry {
  toolUseId: string;
  name: string;
  displayTitle: string;
  status: 'in_progress' | 'complete' | 'error';
  resultSummary?: string;
  source?: { type: 'url'; url: string; text: string };
  editDiff?: { filePath: string; oldString: string; newString: string };
  writeContent?: { filePath: string; content: string };
}

interface ReasoningCard {
  id: string;
  title: string;
  reasoningText: string;
  status: 'pending' | 'in_progress' | 'complete' | 'error';
  tools: ToolEntry[];
  isSubagent: boolean;
  subagentMeta?: { agentType?: string; model?: string; toolUses?: number; durationMs?: number };
}

interface TrackedTask {
  taskId: string;
  subject: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
}

// ── CardManager ─────────────────────────────────────────────────────
// Manages reasoning cards: creation, tool attachment, finalization.

class CardManager {
  cards: ReasoningCard[] = [];
  currentCard: ReasoningCard | null = null;
  private nextCardId = 0;
  compactingCard: ReasoningCard | null = null;

  /** Deduplicated tool use IDs. */
  seenToolUseIds = new Set<string>();
  /** Deduplicated tool result IDs. */
  processedToolResultIds = new Set<string>();

  /** Pending reasoning text not yet attached to a card. */
  pendingReasoning = '';

  /** Map from toolUseId to input for contextual thinking. */
  toolInputMap = new Map<string, { name: string; input: Record<string, unknown> }>();

  createCard(title: string, reasoningText: string, isSubagent: boolean, subagentMeta?: ReasoningCard['subagentMeta']): ReasoningCard {
    const card: ReasoningCard = {
      id: `card-${this.nextCardId++}`,
      title,
      reasoningText,
      status: 'in_progress',
      tools: [],
      isSubagent,
      subagentMeta,
    };
    this.cards.push(card);
    return card;
  }

  createReasoningCard(toolName: string, input: Record<string, unknown>): void {
    const reasoning = this.pendingReasoning;
    this.pendingReasoning = '';

    const title = reasoning
      ? truncate(extractFirstLine(reasoning), 80)
      : fallbackTitle(toolName, input);

    // Merge with previous card if it has the same title (avoids duplicate blocks)
    const lastCard = this.cards[this.cards.length - 1];
    if (lastCard && lastCard.title === title && !lastCard.isSubagent) {
      lastCard.status = 'in_progress';
      if (reasoning && !detailsMatchesTitle(reasoning, title)) {
        lastCard.reasoningText += (lastCard.reasoningText ? '\n' : '') + reasoning;
      }
      this.currentCard = lastCard;
      return;
    }

    this.currentCard = this.createCard(title, reasoning, false);
  }

  finalizeCurrentCard(): void {
    if (this.currentCard && this.currentCard.status === 'in_progress') {
      this.currentCard.status = 'complete';
    }
    this.currentCard = null;
  }

  addToolToCard(card: ReasoningCard, toolUseId: string, toolName: string, input: Record<string, unknown>): void {
    const displayTitle = toolDisplayTitle(toolName, input);
    const entry: ToolEntry = { toolUseId, name: toolName, displayTitle, status: 'in_progress' };

    // Attach source for Edit/Write/WebFetch
    if (toolName === 'Edit' || toolName === 'Write') {
      const fp = typeof input.file_path === 'string' ? input.file_path : undefined;
      if (fp) {
        const { url, text } = fileSource(fp);
        entry.source = { type: 'url', url, text };
      }
      // Store diff data for Edit tools
      if (toolName === 'Edit' && fp) {
        const oldStr = typeof input.old_string === 'string' ? input.old_string : undefined;
        const newStr = typeof input.new_string === 'string' ? input.new_string : undefined;
        if (oldStr !== undefined && newStr !== undefined) {
          entry.editDiff = { filePath: fp, oldString: oldStr, newString: newStr };
        }
      }
      // Store content for Write tools
      if (toolName === 'Write' && fp) {
        const content = typeof input.content === 'string' ? input.content : undefined;
        if (content !== undefined) {
          entry.writeContent = { filePath: fp, content };
        }
      }
    } else if (toolName === 'WebFetch') {
      const url = typeof input.url === 'string' ? input.url : undefined;
      if (url) {
        try {
          const parsed = new URL(url);
          entry.source = { type: 'url', url, text: parsed.host + parsed.pathname };
        } catch {
          entry.source = { type: 'url', url, text: url };
        }
      }
    }

    card.tools.push(entry);
  }

  findToolInCards(toolUseId: string): { card: ReasoningCard; tool: ToolEntry } | null {
    for (const card of this.cards) {
      for (const tool of card.tools) {
        if (tool.toolUseId === toolUseId) return { card, tool };
      }
    }
    return null;
  }

  findSubagentTool(toolUseId: string): { card: ReasoningCard; tool: ToolEntry } | null {
    for (const card of this.cards) {
      if (!card.isSubagent) continue;
      const tool = card.tools.find(t => t.toolUseId === toolUseId);
      if (tool) return { card, tool };
    }
    return null;
  }

  getCardSources(card: ReasoningCard): URLSourceElement[] {
    const seen = new Set<string>();
    const sources: URLSourceElement[] = [];
    for (const tool of card.tools) {
      if (!tool.source) continue;
      const key = tool.source.url || tool.source.text;
      if (seen.has(key)) continue;
      seen.add(key);
      sources.push(tool.source);
    }
    return sources;
  }

  buildToolLines(tools: ToolEntry[]): string[] {
    return tools.map(tool => {
      const icon = tool.status === 'complete' ? '\u2713' : tool.status === 'error' ? '\u2717' : '\u25B8';
      return `${icon} ${tool.displayTitle}`;
    });
  }
}

// ── TodoManager ─────────────────────────────────────────────────────
// Tracks todo items and tasks, merges them, and builds stream chunks.

class TodoManager {
  private todoCard: { todos: TodoItem[] } | null = null;
  private trackedTasks = new Map<string, TrackedTask>();
  private nextTaskCreateId = 1;

  // Delta tracking for todo streaming
  private todoSentStatus = new Map<string, string>();
  lastSentTodoPlanTitle = '';

  onTodoUpdate(todos: TodoItem[]): void {
    this.todoCard = { todos };
  }

  onTaskCreate(subject: string, activeForm?: string): void {
    const taskId = String(this.nextTaskCreateId++);
    this.trackedTasks.set(taskId, { taskId, subject, status: 'pending', activeForm });
  }

  onTaskUpdate(taskId: string, updates: { status?: string; subject?: string; activeForm?: string }): void {
    const task = this.trackedTasks.get(taskId);
    if (!task) return;
    if (updates.status === 'pending' || updates.status === 'in_progress' || updates.status === 'completed') {
      task.status = updates.status;
    }
    if (updates.subject !== undefined) task.subject = updates.subject;
    if (updates.activeForm !== undefined) task.activeForm = updates.activeForm;
  }

  getAllTodoItems(): TodoItem[] {
    const items: TodoItem[] = [];
    const seen = new Map<string, number>(); // key -> index in items[]

    if (this.todoCard) {
      for (const t of this.todoCard.todos) {
        const key = t.content.toLowerCase();
        const existing = seen.get(key);
        if (existing !== undefined) {
          items[existing] = t; // last occurrence wins
          continue;
        }
        seen.set(key, items.length);
        items.push(t);
      }
    }

    for (const task of this.trackedTasks.values()) {
      const key = task.subject.toLowerCase();
      const existing = seen.get(key);
      const item: TodoItem = {
        content: task.subject,
        status: task.status,
        activeForm: task.activeForm,
      };
      if (existing !== undefined) {
        items[existing] = item; // last occurrence wins
        continue;
      }
      seen.set(key, items.length);
      items.push(item);
    }

    return items;
  }

  hasTodoItems(): boolean {
    return this.getAllTodoItems().length > 0;
  }

  /**
   * True when the todo stream has nothing active left to display:
   * either all items are completed, or the list was cleared.
   * Only meaningful after at least one TodoWrite call (todoCard exists).
   */
  todoStreamDone(): boolean {
    if (!this.todoCard) return false; // never been set — no stream to close
    const items = this.getAllTodoItems();
    return items.length === 0 || items.every(t => t.status === 'completed');
  }

  buildTodoStreamChunks(): AnyChunk[] {
    const allTodos = this.getAllTodoItems();
    if (allTodos.length === 0) return [];

    const chunks: AnyChunk[] = [];

    const completed = allTodos.filter(t => t.status === 'completed').length;
    const planTitle = completed > 0
      ? `Task Progress (${completed}/${allTodos.length})`
      : 'Task Progress';
    if (planTitle !== this.lastSentTodoPlanTitle) {
      this.lastSentTodoPlanTitle = planTitle;
      chunks.push({ type: 'plan_update', title: planTitle } as PlanUpdateChunk);
    }

    for (let i = 0; i < allTodos.length; i++) {
      const item = allTodos[i];
      const statusMap: Record<string, 'in_progress' | 'complete'> = {
        completed: 'complete',
        in_progress: 'in_progress',
      };
      const title = item.status === 'in_progress' && item.activeForm
        ? item.activeForm
        : item.content;
      const chunkId = `todo-${i}`;
      const status = statusMap[item.status] ?? 'pending';

      const prevStatus = this.todoSentStatus.get(chunkId);
      if (prevStatus === status) continue;

      this.todoSentStatus.set(chunkId, status);

      chunks.push({
        type: 'task_update',
        id: chunkId,
        title,
        status,
      } as TaskUpdateChunk);
    }

    return chunks;
  }
}

// ── ThinkingTextBuilder ─────────────────────────────────────────────
// Generates contextual status text based on current/last tool.

class ThinkingTextBuilder {
  private lastCompletedTool = '';
  private lastCompletedToolInput: Record<string, unknown> = {};

  onToolResult(toolName: string, input: Record<string, unknown>): void {
    this.lastCompletedTool = toolName;
    this.lastCompletedToolInput = input;
  }

  buildThinkingText(): string {
    const tool = this.lastCompletedTool;
    const input = this.lastCompletedToolInput;

    if (!tool) return 'is thinking...';

    switch (tool) {
      case 'Read':
        return `is analyzing ${typeof input.file_path === 'string' ? shortPath(input.file_path) : 'the code'}...`;
      case 'Edit':
        return 'is reviewing the changes...';
      case 'Write':
        return 'is reviewing the new file...';
      case 'Bash':
        return 'is reviewing the output...';
      case 'Grep':
        return 'is reviewing search results...';
      case 'Glob':
        return 'is reviewing matching files...';
      case 'Agent':
        return 'is reviewing agent results...';
      case 'WebFetch':
      case 'WebSearch':
        return 'is reviewing web results...';
      case 'TodoWrite':
      case 'TaskCreate':
      case 'TaskUpdate':
      case 'TaskList':
        return 'is thinking...';
      default:
        return 'is thinking...';
    }
  }

  buildTypingText(toolName: string, input: Record<string, unknown>, elapsedSeconds?: number): string {
    const elapsed = elapsedSeconds !== undefined && elapsedSeconds >= 1
      ? ` (${Math.round(elapsedSeconds)}s)`
      : '';

    switch (toolName) {
      case 'Read':
        return `is reading ${typeof input.file_path === 'string' ? shortPath(input.file_path) : 'files'}...${elapsed}`;
      case 'Edit':
        return `is editing ${typeof input.file_path === 'string' ? shortPath(input.file_path) : 'a file'}...${elapsed}`;
      case 'Write':
        return `is writing ${typeof input.file_path === 'string' ? shortPath(input.file_path) : 'a file'}...${elapsed}`;
      case 'Bash': {
        const desc = typeof input.description === 'string' ? input.description : '';
        return desc ? `is running: ${truncate(desc, 60)}${elapsed}` : `is running a command...${elapsed}`;
      }
      case 'Grep':
        return `is searching for \`${input.pattern ?? 'pattern'}\`...${elapsed}`;
      case 'Glob':
        return `is finding files...${elapsed}`;
      case 'Agent': {
        const desc = typeof input.description === 'string' ? input.description : 'a subtask';
        return `is working on: ${truncate(desc, 60)}${elapsed}`;
      }
      case 'Skill': {
        const skill = typeof input.skill === 'string' ? input.skill : 'a skill';
        return `is loading skill \`${skill}\`...${elapsed}`;
      }
      default:
        return `is working...${elapsed}`;
    }
  }
}

// ── ProgressTracker (public API) ────────────────────────────────────

export class ProgressTracker {
  private cardMgr = new CardManager();
  private todoMgr = new TodoManager();
  private thinkingBuilder = new ThinkingTextBuilder();

  /** Plan title for PlanUpdateChunk and final PlanBlock. */
  private planTitle = '';
  /** Last plan title emitted as a PlanUpdateChunk. */
  private lastSentPlanTitle = '';

  /** Snapshot-based dedup: tracks id -> "id:status" for each sent chunk. */
  private lastSentSnapshot = new Map<string, string>();

  /** Delta tracking for reasoning card streaming. */
  private cardSentDetailsLen = new Map<string, number>();
  private cardSentToolCount = new Map<string, number>();
  private cardSentSourceUrls = new Map<string, Set<string>>();

  /** Tracks which Edit/Write tool diffs have been emitted as markdown_text chunks. */
  private editDiffsSent = new Set<string>();
  private writeContentSent = new Set<string>();

  /** Pending file uploads for truncated content (drained by worker-loop). */
  private _pendingUploads: { filename: string; content: string; caption: string }[] = [];

  // ── Plan title ──────────────────────────────────────────────────

  setProjectDir(dir: string): void {
    _projectDir = dir;
  }

  setPlanTitle(title: string): void {
    this.planTitle = title;
  }

  getPlanTitle(): string {
    return this.planTitle;
  }

  // ── Reasoning text ──────────────────────────────────────────────

  onReasoningText(text: string): void {
    if (!text.trim()) return;
    this.cardMgr.pendingReasoning = text;
  }

  // ── Tool use ────────────────────────────────────────────────────

  onToolUse(toolName: string, input: Record<string, unknown>, toolUseId: string): void {
    if (toolName === 'TodoWrite' || toolName === 'TaskCreate' || toolName === 'TaskUpdate' || toolName === 'TaskList') return;

    if (this.cardMgr.seenToolUseIds.has(toolUseId)) return;
    this.cardMgr.seenToolUseIds.add(toolUseId);

    this.cardMgr.toolInputMap.set(toolUseId, { name: toolName, input });

    // Task (subagent) -> dedicated card
    if (toolName === 'Agent') {
      this.cardMgr.finalizeCurrentCard();
      const desc = typeof input.description === 'string' ? input.description : 'Subtask';
      const agentType = typeof input.subagent_type === 'string' ? input.subagent_type : undefined;
      const model = typeof input.model === 'string' ? input.model : undefined;
      const card = this.cardMgr.createCard(truncate(desc, 80), '', true, { agentType, model });
      card.tools.push({ toolUseId, name: toolName, displayTitle: desc, status: 'in_progress' });
      return;
    }

    // Regular tool -> current or new reasoning card
    // If new reasoning appeared, start a new card group (group by reasoning blocks)
    if (!this.cardMgr.currentCard || this.cardMgr.currentCard.status === 'complete') {
      this.cardMgr.createReasoningCard(toolName, input);
    } else if (this.cardMgr.pendingReasoning) {
      this.cardMgr.finalizeCurrentCard();
      this.cardMgr.createReasoningCard(toolName, input);
    }

    this.cardMgr.addToolToCard(this.cardMgr.currentCard!, toolUseId, toolName, input);
  }

  // ── Tool result ─────────────────────────────────────────────────

  onToolResult(toolName: string, toolUseId: string, resultSummary?: string): void {
    if (toolName === 'TodoWrite' || toolName === 'TaskCreate' || toolName === 'TaskUpdate' || toolName === 'TaskList') return;

    if (this.cardMgr.processedToolResultIds.has(toolUseId)) return;
    this.cardMgr.processedToolResultIds.add(toolUseId);

    // Track last completed tool for contextual thinking messages
    const toolInfo = this.cardMgr.toolInputMap.get(toolUseId);
    if (toolInfo) {
      this.thinkingBuilder.onToolResult(toolInfo.name, toolInfo.input);
    }

    // Check subagent cards first
    const subagent = this.cardMgr.findSubagentTool(toolUseId);
    if (subagent) {
      subagent.tool.status = 'complete';
      subagent.tool.resultSummary = resultSummary ? stripUsageBlock(resultSummary) : undefined;
      subagent.card.status = 'complete';
      if (resultSummary) {
        const meta = parseSubagentMeta(resultSummary);
        if (meta) {
          subagent.card.subagentMeta = { ...subagent.card.subagentMeta, ...meta };
        }
      }
      return;
    }

    // Regular tool in any card
    const found = this.cardMgr.findToolInCards(toolUseId);
    if (found) {
      found.tool.status = 'complete';
      const maxLen = (toolName === 'Edit' || toolName === 'Write') ? 500 : 100;
      found.tool.resultSummary = resultSummary ? truncate(resultSummary, maxLen) : undefined;
    }
  }

  // ── Todo list ───────────────────────────────────────────────────

  onTodoUpdate(todos: TodoItem[]): void {
    this.todoMgr.onTodoUpdate(todos);
  }

  // ── Tracked tasks ───────────────────────────────────────────────

  onTaskCreate(subject: string, activeForm?: string): void {
    this.todoMgr.onTaskCreate(subject, activeForm);
  }

  onTaskUpdate(taskId: string, updates: { status?: string; subject?: string; activeForm?: string }): void {
    this.todoMgr.onTaskUpdate(taskId, updates);
  }

  getAllTodoItems(): TodoItem[] {
    return this.todoMgr.getAllTodoItems();
  }

  hasTodoItems(): boolean {
    return this.todoMgr.hasTodoItems();
  }

  todoStreamDone(): boolean {
    return this.todoMgr.todoStreamDone();
  }

  // ── Permission result ──────────────────────────────────────────

  onPermissionResult(toolUseId: string, approved: boolean, opts?: {
    toolNames?: string[];
    lockTexts?: string[];
    alwaysAllow?: boolean;
    alwaysPattern?: string;
  }): void {
    const found = this.cardMgr.findToolInCards(toolUseId);
    if (!found) return;

    // Build a descriptive permission result line.
    // Strip markdown backticks from lockText for plain-text stream display.
    const commandDesc = opts?.lockTexts?.[0]?.replace(/`/g, '');
    let label: string;
    if (!approved) {
      label = commandDesc ? `Denied ${commandDesc}` : 'Denied';
    } else if (opts?.alwaysAllow && opts.alwaysPattern) {
      label = `Always allowed ${opts.alwaysPattern}`;
    } else if (opts?.alwaysAllow) {
      label = 'Always allowed';
    } else {
      label = commandDesc ? `Allowed ${commandDesc}` : 'Allowed';
    }

    // Add as a new tool entry so it appears in the stream output
    // (the original tool line was already sent as a delta and can't be modified).
    found.card.tools.push({
      toolUseId: `perm-${toolUseId}`,
      name: '_permission_result',
      displayTitle: label,
      status: approved ? 'complete' : 'error',
    });
  }

  // ── Compaction ──────────────────────────────────────────────────

  onCompactionStatus(compacting: boolean): void {
    if (compacting) {
      this.cardMgr.finalizeCurrentCard();
      const card = this.cardMgr.createCard('Compacting context', '', false);
      this.cardMgr.compactingCard = card;
    } else if (this.cardMgr.compactingCard) {
      this.cardMgr.compactingCard.status = 'complete';
      this.cardMgr.compactingCard = null;
    }
  }

  // ── Finalization ────────────────────────────────────────────────

  finalizeCurrentCard(): void {
    this.cardMgr.finalizeCurrentCard();
  }

  // ── Build chunks (streaming) ────────────────────────────────────

  buildMainChunks(): AnyChunk[] {
    const allChunks: AnyChunk[] = [];

    // Plan title chunk
    const planChunk = this.buildPlanChunk();
    if (planChunk && this.planTitle !== this.lastSentPlanTitle) {
      this.lastSentPlanTitle = this.planTitle;
      allChunks.push(planChunk);
    }

    // Reasoning card task chunks
    for (const card of this.cardMgr.cards) {
      const chunk = this.buildReasoningChunk(card);
      const snapshot = `${chunk.id}:${chunk.status}`;
      const statusChanged = this.lastSentSnapshot.get(chunk.id) !== snapshot;
      const hasNewContent = !!(chunk.details || chunk.output);
      if (statusChanged || hasNewContent) {
        this.lastSentSnapshot.set(chunk.id, snapshot);
        allChunks.push(chunk);
      }

      // Emit edit diffs and write content as separate markdown_text chunks
      for (const tool of card.tools) {
        if (
          tool.name === 'Edit' &&
          tool.status === 'complete' &&
          tool.editDiff &&
          !this.editDiffsSent.has(tool.toolUseId)
        ) {
          this.editDiffsSent.add(tool.toolUseId);
          const diffResult = formatDiffMarkdownEx({
            file_path: shortPath(tool.editDiff.filePath),
            old_string: tool.editDiff.oldString,
            new_string: tool.editDiff.newString,
          });
          if (diffResult) {
            allChunks.push({
              type: 'markdown_text',
              text: diffResult.text + '\n\n',
            } as AnyChunk);
            if (diffResult.truncated) {
              const fullDiff = formatFullDiff({
                file_path: tool.editDiff.filePath,
                old_string: tool.editDiff.oldString,
                new_string: tool.editDiff.newString,
              });
              if (fullDiff) {
                const fname = (tool.editDiff.filePath.split('/').pop() ?? 'edit') + '.diff';
                this._pendingUploads.push({ filename: fname, content: fullDiff, caption: `Full diff for ${shortPath(tool.editDiff.filePath)}` });
              }
            }
          }
        }

        if (
          tool.name === 'Write' &&
          tool.status === 'complete' &&
          tool.writeContent &&
          !this.writeContentSent.has(tool.toolUseId)
        ) {
          this.writeContentSent.add(tool.toolUseId);
          const createResult = formatFileCreateMarkdown(
            shortPath(tool.writeContent.filePath),
            tool.writeContent.content,
          );
          if (createResult) {
            allChunks.push({
              type: 'markdown_text',
              text: createResult.text + '\n\n',
            } as AnyChunk);
            if (createResult.truncated) {
              const fname = tool.writeContent.filePath.split('/').pop() ?? 'file';
              this._pendingUploads.push({ filename: fname, content: tool.writeContent.content, caption: `Full content of ${shortPath(tool.writeContent.filePath)}` });
            }
          }
        }
      }
    }

    return allChunks;
  }

  /** Drain pending file uploads (for truncated edits/creates). Returns and clears the queue. */
  drainPendingUploads(): { filename: string; content: string; caption: string }[] {
    if (this._pendingUploads.length === 0) return [];
    const uploads = this._pendingUploads;
    this._pendingUploads = [];
    return uploads;
  }

  buildTodoChunks(): AnyChunk[] {
    return this.buildTodoStreamChunks();
  }

  // ── Plan chunk ──────────────────────────────────────────────────

  buildPlanChunk(): PlanUpdateChunk | null {
    if (!this.planTitle) return null;
    return { type: 'plan_update', title: this.planTitle };
  }

  // ── Todo stream chunks ──────────────────────────────────────────

  buildTodoStreamChunks(): AnyChunk[] {
    return this.todoMgr.buildTodoStreamChunks();
  }

  // ── Thinking / Typing text ──────────────────────────────────────

  buildThinkingText(): string {
    return this.thinkingBuilder.buildThinkingText();
  }

  buildTypingText(toolName: string, input: Record<string, unknown>, elapsedSeconds?: number): string {
    return this.thinkingBuilder.buildTypingText(toolName, input, elapsedSeconds);
  }

  buildTypingTextForTool(toolUseId: string, elapsedSeconds?: number): string {
    const info = this.cardMgr.toolInputMap.get(toolUseId);
    if (!info) return this.thinkingBuilder.buildThinkingText();
    return this.thinkingBuilder.buildTypingText(info.name, info.input, elapsedSeconds);
  }

  // ── For testing ─────────────────────────────────────────────────

  getCards(): ReasoningCard[] {
    return [...this.cardMgr.cards];
  }

  // ── Private helpers ─────────────────────────────────────────────

  private buildReasoningChunk(card: ReasoningCard): TaskUpdateChunk {
    const rawDetails = card.reasoningText || '';
    const fullDetails = detailsMatchesTitle(rawDetails, card.title) ? '' : rawDetails;
    const sentDetailsLen = this.cardSentDetailsLen.get(card.id) ?? 0;
    const detailsDelta = fullDetails.substring(sentDetailsLen);

    // Include all tools (including in_progress) so the stream shows what's
    // currently running.  During streaming ▸ is fine for tools that just started.
    const allLines = this.cardMgr.buildToolLines(card.tools);
    const sentToolCount = this.cardSentToolCount.get(card.id) ?? 0;
    const rawNewLines = allLines.slice(sentToolCount);

    // Deduplicate: skip lines identical to the previously emitted line
    // (e.g. two consecutive "▸ Edit README.md" from multiple edits to same file)
    const lastSentLine = sentToolCount > 0 ? allLines[sentToolCount - 1] : null;
    const newToolLines: string[] = [];
    let prevLine = lastSentLine;
    for (const line of rawNewLines) {
      if (line !== prevLine) {
        newToolLines.push(line);
      }
      prevLine = line;
    }

    const allSources = this.cardMgr.getCardSources(card);
    const sentUrls = this.cardSentSourceUrls.get(card.id) ?? new Set<string>();
    const newSources = allSources.filter(s => !sentUrls.has(s.url));

    // Advance delta counters inline
    this.cardSentDetailsLen.set(card.id, fullDetails.length);
    this.cardSentToolCount.set(card.id, allLines.length);
    for (const s of newSources) sentUrls.add(s.url);
    this.cardSentSourceUrls.set(card.id, sentUrls);

    return {
      type: 'task_update',
      id: card.id,
      title: card.title,
      status: card.status,
      details: detailsDelta,
      output: newToolLines.length > 0 ? (sentToolCount > 0 ? '\n' : '') + newToolLines.join('\n') : '',
      ...(newSources.length > 0 ? { sources: newSources } : {}),
    };
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

export function shortPath(filePath: string): string {
  const parts = filePath.split('/');
  return parts.length > 3 ? parts.slice(-3).join('/') : filePath;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '\u2026' : s;
}

function extractFirstLine(text: string): string {
  const lines = text.trim().split('\n').filter(l => l.trim());
  if (lines.length === 0) return '';
  return lines[0].replace(/^[#*\->\s]+/, '').trim();
}

function detailsMatchesTitle(details: string, title: string): boolean {
  if (!details.trim()) return true;
  const lines = details.trim().split('\n').filter(l => l.trim());
  if (lines.length > 1) return false;
  const normalized = extractFirstLine(details);
  return normalized === title;
}

function parseSubagentMeta(result: string): { toolUses?: number; durationMs?: number } | null {
  const usageMatch = result.match(/<usage>([\s\S]*?)<\/usage>/);
  if (!usageMatch) return null;
  const usage = usageMatch[1];
  const toolUses = usage.match(/tool_uses:\s*(\d+)/);
  const duration = usage.match(/duration_ms:\s*(\d+)/);
  return {
    toolUses: toolUses ? parseInt(toolUses[1], 10) : undefined,
    durationMs: duration ? parseInt(duration[1], 10) : undefined,
  };
}

export function stripUsageBlock(text: string): string {
  return text
    .replace(/<usage>[\s\S]*?<\/usage>/g, '')
    .replace(/^agentId:\s*\S+\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function toRichText(text: string): RichTextBlock {
  return {
    type: 'rich_text',
    elements: [{
      type: 'rich_text_section',
      elements: [{ type: 'text', text }],
    }],
  };
}


function fallbackTitle(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'Edit':
      return `Editing ${typeof input.file_path === 'string' ? shortPath(input.file_path) : 'file'}`;
    case 'Write':
      return `Writing ${typeof input.file_path === 'string' ? shortPath(input.file_path) : 'file'}`;
    case 'Bash': {
      const desc = typeof input.description === 'string' ? input.description : '';
      const cmd = typeof input.command === 'string' ? input.command : '';
      return desc ? truncate(desc, 80) : cmd ? `Running \`${truncate(cmd, 60)}\`` : 'Running command';
    }
    case 'Grep':
    case 'Glob':
      return 'Searching codebase';
    case 'Read':
      return 'Reading files';
    case 'WebSearch':
    case 'WebFetch':
      return 'Searching the web';
    case 'Skill': {
      const skill = typeof input.skill === 'string' ? input.skill : 'skill';
      return `Loading skill \`${skill}\``;
    }
    case 'Agent': {
      const desc = typeof input.description === 'string' ? input.description : '';
      const agentType = typeof input.subagent_type === 'string' ? input.subagent_type : '';
      const label = agentType ? `Agent (${agentType})` : 'Agent';
      return desc ? `${label}: ${truncate(desc, 80)}` : label;
    }
    default:
      return 'Working';
  }
}

function toolDisplayTitle(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'Edit':
      return `Edit ${typeof input.file_path === 'string' ? shortPath(input.file_path) : 'file'}`;
    case 'Write':
      return `Write ${typeof input.file_path === 'string' ? shortPath(input.file_path) : 'file'}`;
    case 'Read':
      return `Read ${typeof input.file_path === 'string' ? shortPath(input.file_path) : 'file'}`;
    case 'Bash': {
      const desc = typeof input.description === 'string' ? input.description : '';
      const cmd = typeof input.command === 'string' ? input.command : '';
      return desc ? truncate(desc, 80) : cmd ? truncate(cmd, 80) : 'Run command';
    }
    case 'Grep':
      return `Search for \`${truncate(String(input.pattern ?? 'pattern'), 40)}\``;
    case 'Glob':
      return `Find files matching \`${truncate(String(input.pattern ?? '*'), 40)}\``;
    case 'WebSearch':
      return `Search web for \`${truncate(String(input.query ?? 'query'), 40)}\``;
    case 'WebFetch':
      return `Fetch ${truncate(String(input.url ?? 'URL'), 60)}`;
    case 'Skill': {
      const skill = typeof input.skill === 'string' ? input.skill : 'skill';
      return `Load skill \`${skill}\``;
    }
    case 'Agent': {
      const desc = typeof input.description === 'string' ? input.description : '';
      const agentType = typeof input.subagent_type === 'string' ? input.subagent_type : '';
      const label = agentType ? `Agent (${agentType})` : 'Agent';
      return desc ? `${label}: ${truncate(desc, 60)}` : label;
    }
    default:
      return `${toolName}`;
  }
}
