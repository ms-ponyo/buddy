// src/hooks/can-use-tool.ts — CanUseTool hook factory.
// Gates tool execution behind permission checks.
// Returns a function matching the SDK's CanUseTool signature.

import type { CanUseTool, PermissionResult, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import type { Logger } from '../logger.js';
import type { PermissionManager } from '../services/permission-manager.js';
import type { ConfigOverrides } from '../services/config-overrides.js';
import type { ToolRisk, AskUserQuestionItem } from '../types.js';
import { classifyToolRisk } from '../ui/permission-blocks.js';

// ── Dependencies ──────────────────────────────────────────────────

export interface CanUseToolHookDeps {
  permissions: PermissionManager;
  configOverrides: ConfigOverrides;
  logger: Logger;
  channel: string;
  threadTs: string;
  previewMode: 'off' | 'destructive' | 'moderate';
  /** When set, Edit/Write/NotebookEdit targeting files under this dir are auto-allowed. */
  projectDir?: string;
}

// ── Info tools that are always auto-allowed ──────────────────────

const INFO_TOOLS = new Set([
  'Read',
  'Grep',
  'Glob',
  'WebFetch',
  'WebSearch',
]);

// ── File tools auto-allowed in acceptEdits mode ──────────────────

const FILE_TOOLS = new Set([
  'Edit',
  'Write',
  'NotebookEdit',
]);

// ── Factory ───────────────────────────────────────────────────────

/**
 * Create a canUseTool hook function matching the SDK's CanUseTool signature.
 * The returned function is called before each tool execution to determine
 * if it should be allowed.
 */
export function createCanUseToolHook(deps: CanUseToolHookDeps): CanUseTool {
  const {
    permissions,
    configOverrides,
    logger,
    channel,
    threadTs,
    projectDir,
  } = deps;

  /** Track patterns the user has already "Always allowed" so we don't suggest them again. */
  const approvedPatterns = new Set<string>();

  return async (
    toolName: string,
    toolInput: Record<string, unknown>,
    options,
  ): Promise<PermissionResult> => {
    const { toolUseID, suggestions, title, description, blockedPath } = options;
    const permissionMode = configOverrides.getPermissionMode();

    // ── AskUserQuestion: delegate to PermissionManager ──────────
    if (toolName === 'AskUserQuestion') {
      const questions = (toolInput.questions ?? []) as AskUserQuestionItem[];
      logger.info('AskUserQuestion intercepted via canUseTool', {
        questionCount: questions.length,
      });

      const answer = await permissions.askUserQuestion({
        callbackId: toolUseID,
        questions,
      });

      // Return deny with the user's answer so the SDK relays it back
      return {
        behavior: 'deny',
        message: `The user answered your question(s):\n${answer}\n\nProceed with the user's selections.`,
        toolUseID,
      };
    }

    // ── ExitPlanMode: auto-allow (review handled by PreToolUse hook) ─
    if (toolName === 'ExitPlanMode') {
      logger.info('ExitPlanMode reached canUseTool (hook already handled review)');
      return { behavior: 'allow', updatedInput: toolInput, toolUseID };
    }

    // ── bypassPermissions mode: allow everything ──────────────
    if (permissionMode === 'bypassPermissions' || permissionMode === 'auto') {
      logger.info('Auto-allowing tool (bypassPermissions mode)', { tool: toolName });
      return { behavior: 'allow', updatedInput: toolInput, toolUseID };
    }

    // ── plan mode: allow everything (plan review handles gating) ──
    if (permissionMode === 'plan') {
      logger.info('Auto-allowing tool (plan mode)', { tool: toolName });
      return { behavior: 'allow', updatedInput: toolInput, toolUseID };
    }

    // ── Info tools: always auto-allow ──────────────────────────
    if (INFO_TOOLS.has(toolName)) {
      return { behavior: 'allow', updatedInput: toolInput, toolUseID };
    }

    // ── acceptEdits mode: auto-allow file tools ────────────────
    if (permissionMode === 'acceptEdits' && FILE_TOOLS.has(toolName)) {
      logger.info('Auto-allowing file tool (acceptEdits mode)', { tool: toolName });
      return { behavior: 'allow', updatedInput: toolInput, toolUseID };
    }

    // ── File tools within projectDir: auto-allow ─────────────
    if (projectDir && FILE_TOOLS.has(toolName)) {
      const filePath = typeof toolInput.file_path === 'string'
        ? toolInput.file_path
        : typeof toolInput.notebook_path === 'string'
          ? toolInput.notebook_path
          : undefined;
      if (filePath && filePath.startsWith(projectDir)) {
        logger.info('Auto-allowing file tool (within projectDir)', { tool: toolName, filePath });
        return { behavior: 'allow', updatedInput: toolInput, toolUseID };
      }
    }

    // ── Classify risk ──────────────────────────────────────────
    const risk: ToolRisk = classifyToolRisk(toolName, toolInput);

    // ── dontAsk mode: allow non-destructive ────────────────────
    if (permissionMode === 'dontAsk' && risk !== 'destructive') {
      logger.info('Auto-allowing tool (dontAsk mode, non-destructive)', { tool: toolName, risk });
      return { behavior: 'allow', updatedInput: toolInput, toolUseID };
    }

    // ── Request permission from user ───────────────────────────
    logger.info('Permission requested via canUseTool', {
      tool: toolName, risk, title, blockedPath,
    });

    // Prefer the SDK-provided title/description for the Slack prompt
    // (e.g. folder access: "Claude will have read and write access to files in ~/Downloads")
    const lockText = title || formatLockText(toolName, toolInput, description);

    const rawSuggestions = suggestions && suggestions.length > 0
      ? suggestions
      : generateFallbackSuggestions(toolName, toolInput);
    const filteredSuggestions = filterApprovedSuggestions(rawSuggestions, approvedPatterns);

    const permResult = await permissions.requestPermission({
      toolName,
      toolInput,
      callbackId: toolUseID,
      channel,
      threadTs,
      risk,
      lockText,
      suggestions: filteredSuggestions,
    });

    if (permResult.approved) {
      // Track patterns from "Always allow" so we skip them in future suggestions
      const perms = permResult.updatedPermissions as PermissionUpdate[] | undefined;
      if (perms) {
        recordApprovedPatterns(perms, approvedPatterns);
      }

      return {
        behavior: 'allow',
        updatedInput: toolInput,
        updatedPermissions: perms,
        toolUseID,
      };
    }

    return {
      behavior: 'deny',
      message: permResult.message ?? 'Denied by user',
      toolUseID,
    };
  };
}

// ── Helpers ───────────────────────────────────────────────────────

function formatLockText(
  toolName: string,
  toolInput: Record<string, unknown>,
  description?: string,
): string {
  if (toolName === 'Bash' && typeof toolInput.command === 'string') {
    // Collapse newlines to spaces so multi-line commands (e.g. python3 -c "...") display inline
    const collapsed = toolInput.command.replace(/\n/g, ' ').replace(/\s{2,}/g, ' ');
    const cmd = collapsed.length > 100
      ? collapsed.slice(0, 100) + '...'
      : collapsed;
    return `\`Bash\` -> \`${cmd}\``;
  }
  if ((toolName === 'Write' || toolName === 'Edit') && typeof toolInput.file_path === 'string') {
    return `\`${toolName}\` -> \`${toolInput.file_path}\``;
  }
  if (description) {
    return `\`${toolName}\` — ${description}`;
  }
  return `\`${toolName}\``;
}

// ── Fallback suggestion generation ──────────────────────────────

/** Tools where the subcommand (second token) is meaningful. */
const MULTI_WORD_TOOLS = new Set([
  'git', 'npm', 'npx', 'yarn', 'pnpm', 'bun', 'bunx',
  'docker', 'cargo', 'kubectl', 'terraform', 'aws', 'gcloud',
  'go', 'pip', 'poetry', 'gradle', 'mvn', 'make',
]);

/** Find the first subcommand token, skipping flags and their values. */
function findSubcommand(tokens: string[]): string | undefined {
  let skipNext = false;
  for (const t of tokens) {
    if (skipNext) { skipNext = false; continue; }
    if (t.startsWith('-')) {
      // Single-letter flags like -C take a value; long flags with = are self-contained
      if (!t.startsWith('--') && !t.includes('=') && t.length === 2) {
        skipNext = true;
      }
      continue;
    }
    // Skip paths (likely flag values that slipped through)
    if (t.includes('/')) continue;
    return t;
  }
  return undefined;
}

/**
 * Extract a permission pattern prefix from a single command segment.
 * For multi-word tools (git, npm, etc.), uses first 2 tokens; otherwise first token.
 *
 * Examples:
 *   "git pull --rebase"  → "git pull"
 *   "npm run build"      → "npm run"
 *   "ls -la /some/path"  → "ls"
 */
function extractSinglePattern(cmd: string): string | undefined {
  const tokens = cmd.split(/\s+/);
  const first = tokens[0];
  if (!first) return undefined;

  // Use base name in case of absolute paths (e.g., /usr/bin/git)
  const baseName = first.includes('/') ? first.split('/').pop()! : first;

  if (MULTI_WORD_TOOLS.has(baseName) && tokens.length >= 2) {
    const sub = findSubcommand(tokens.slice(1));
    if (sub) return `${baseName} ${sub}`;
  }

  return baseName;
}

/**
 * Extract permission pattern prefixes from a Bash command.
 * Strips leading `cd ... &&` chains, then extracts a pattern from each
 * segment separated by pipes (`|`) or `&&`/`||` chains.
 *
 * Examples:
 *   "cd /path && git pull --rebase"           → ["git pull"]
 *   "cat package.json | grep -A5 test"        → ["cat", "grep"]
 *   "npm run build && npm run test"           → ["npm run"]  (deduped)
 *   "ls -la /some/path"                       → ["ls"]
 */
/** Commands that take inline script via -c (contents should not be parsed as bash). */
const INLINE_SCRIPT_COMMANDS = new Set([
  'python', 'python3', 'python2', 'ruby', 'perl', 'node', 'sh', 'bash', 'zsh',
]);

export function extractBashPatterns(command: string): string[] {
  // Strip chained `cd <path> &&` prefixes
  const stripped = command.replace(/^(?:cd\s+\S+\s*&&\s*)+/, '').trim();
  if (!stripped) return [];

  // Split on pipes and logical operators, then extract pattern from each segment
  const segments = stripped.split(/\s*(?:\|&|\||&&|\|\|)\s*/);
  const seen = new Set<string>();
  const patterns: string[] = [];

  for (const seg of segments) {
    const trimmed = seg.trim();
    if (!trimmed) continue;
    // Strip trailing redirections (e.g. "2>&1", "> file", "2>/dev/null")
    const withoutRedirects = trimmed.replace(/\s*\d*>[>&]?\s*\S+/g, '').trim();

    // Detect inline-script commands (e.g. "python3 -c '...'") — only extract the command name,
    // don't parse the script body as bash commands.
    const firstToken = (withoutRedirects || trimmed).split(/\s+/)[0];
    const baseName = firstToken?.includes('/') ? firstToken.split('/').pop()! : firstToken;
    if (baseName && INLINE_SCRIPT_COMMANDS.has(baseName) && /\s+-c\s/.test(withoutRedirects || trimmed)) {
      if (!seen.has(baseName)) {
        seen.add(baseName);
        patterns.push(baseName);
      }
      continue;
    }

    const pattern = extractSinglePattern(withoutRedirects || trimmed);
    if (pattern && !seen.has(pattern)) {
      seen.add(pattern);
      patterns.push(pattern);
    }
  }

  return patterns;
}

/**
 * Extract a single permission pattern prefix from a Bash command.
 * @deprecated Use extractBashPatterns for multi-pattern support.
 */
export function extractBashPattern(command: string): string | undefined {
  return extractBashPatterns(command)[0];
}

/**
 * Generate fallback "Always allow" suggestions for Bash commands
 * when the SDK doesn't provide its own suggestions.
 */
function generateFallbackSuggestions(
  toolName: string,
  toolInput: Record<string, unknown>,
): unknown[] | undefined {
  if (toolName !== 'Bash' || typeof toolInput.command !== 'string') return undefined;

  const patterns = extractBashPatterns(toolInput.command);
  if (patterns.length === 0) return undefined;

  return [{
    type: 'addRules',
    rules: patterns.map(p => ({ toolName: 'Bash', ruleContent: `${p}:*` })),
    behavior: 'allow',
    destination: 'session',
  }];
}

/**
 * Remove rules from suggestions whose patterns have already been approved.
 * Returns undefined if all rules are filtered out.
 */
function filterApprovedSuggestions(
  suggestions: unknown[] | undefined,
  approved: Set<string>,
): unknown[] | undefined {
  if (!suggestions || approved.size === 0) return suggestions;

  const filtered: unknown[] = [];
  for (const s of suggestions) {
    if (typeof s !== 'object' || s === null) { filtered.push(s); continue; }
    const suggestion = s as Record<string, unknown>;
    const rules = suggestion.rules;
    if (!Array.isArray(rules)) { filtered.push(s); continue; }

    const remainingRules = rules.filter((rule) => {
      if (typeof rule !== 'object' || rule === null) return true;
      const { toolName, ruleContent } = rule as Record<string, unknown>;
      if (typeof toolName !== 'string' || typeof ruleContent !== 'string') return true;
      return !approved.has(`${toolName}:${ruleContent}`);
    });

    if (remainingRules.length > 0) {
      filtered.push({ ...suggestion, rules: remainingRules });
    }
  }

  return filtered.length > 0 ? filtered : undefined;
}

/**
 * Record patterns from updatedPermissions into the approved set.
 */
function recordApprovedPatterns(
  perms: unknown[],
  approved: Set<string>,
): void {
  for (const p of perms) {
    if (typeof p !== 'object' || p === null) continue;
    const perm = p as Record<string, unknown>;
    const rules = perm.rules;
    if (!Array.isArray(rules)) continue;
    for (const rule of rules) {
      if (typeof rule !== 'object' || rule === null) continue;
      const { toolName, ruleContent } = rule as Record<string, unknown>;
      if (typeof toolName === 'string' && typeof ruleContent === 'string') {
        approved.add(`${toolName}:${ruleContent}`);
      }
    }
  }
}
