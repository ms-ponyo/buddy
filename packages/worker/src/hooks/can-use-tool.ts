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
}

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
  } = deps;

  /** Track patterns the user has already "Always allowed" so we don't suggest them again. */
  const approvedPatterns = new Set<string>();

  return async (
    toolName: string,
    toolInput: Record<string, unknown>,
    options,
  ): Promise<PermissionResult> => {
    const { toolUseID, suggestions, title, description } = options;

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

    // ── ExitPlanMode: deny if it reaches here ─────────────────────
    // The PreToolUse hook handles plan review and returns allow/deny directly.
    // If ExitPlanMode reaches canUseTool, the hook failed (timeout, error, etc.)
    // — deny rather than silently auto-allowing unapproved plans.
    if (toolName === 'ExitPlanMode') {
      logger.warn('ExitPlanMode reached canUseTool unexpectedly (PreToolUse hook should have handled it)');
      return {
        behavior: 'deny',
        message: 'Plan review was not completed — please re-enter plan mode and try again',
        toolUseID,
      };
    }

    // ── Tool overrides: enforce allow/deny lists ──────────────
    const toolOverrides = configOverrides.getToolOverrides();
    if (toolOverrides) {
      const { allowedTools, disallowedTools } = toolOverrides;
      if (disallowedTools?.includes(toolName)) {
        logger.info('Tool denied by tool overrides', { tool: toolName });
        return {
          behavior: 'deny',
          message: `Tool \`${toolName}\` is blocked by thread tool restrictions. Use \`!tools clear\` to reset.`,
          toolUseID,
        };
      }
      if (allowedTools && allowedTools.length > 0 && !allowedTools.includes(toolName)) {
        logger.info('Tool not in allowed list', { tool: toolName, allowedTools });
        return {
          behavior: 'deny',
          message: `Tool \`${toolName}\` is not in the allowed tools list (${allowedTools.join(', ')}). Use \`!tools clear\` to reset.`,
          toolUseID,
        };
      }
    }

    // ── Classify risk ──────────────────────────────────────────
    const risk: ToolRisk = classifyToolRisk(toolName, toolInput);

    // ── Request permission from user ───────────────────────────
    logger.info('Permission requested via canUseTool', {
      tool: toolName, risk, title,
    });

    // Prefer the SDK-provided title/description for the Slack prompt
    // (e.g. folder access: "Claude will have read and write access to files in ~/Downloads")
    const lockText = title || formatLockText(toolName, toolInput, description);

    const sdkSuggestions = suggestions && suggestions.length > 0 ? suggestions : undefined;
    const rawSuggestions = sdkSuggestions && !hasCommentPatterns(sdkSuggestions)
      ? sdkSuggestions
      : generateFallbackSuggestions(toolName, toolInput) ?? sdkSuggestions;
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

// Slack section block mrkdwn text has a 3000-char limit.
// We target ~2800 to leave room for the "*Permission requested:* " prefix and "Always pattern" line.
const MAX_LOCK_TEXT_LENGTH = 2800;

function formatLockText(
  toolName: string,
  toolInput: Record<string, unknown>,
  description?: string,
): string {
  if (toolName === 'Bash' && typeof toolInput.command === 'string') {
    // Collapse newlines to spaces so multi-line commands (e.g. python3 -c "...") display inline
    const collapsed = toolInput.command.replace(/\n/g, ' ').replace(/\s{2,}/g, ' ');
    if (collapsed.length > 100) {
      // Show command in a code block, truncating if needed to stay under Slack's mrkdwn limit
      const prefix = '`Bash` ->\n```\n';
      const suffix = '\n```';
      const maxCmd = MAX_LOCK_TEXT_LENGTH - prefix.length - suffix.length;
      const truncated = collapsed.length > maxCmd
        ? collapsed.slice(0, maxCmd - 4) + ' ...'
        : collapsed;
      return `${prefix}${truncated}${suffix}`;
    }
    return `\`Bash\` -> \`${collapsed}\``;
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

/**
 * Split a command string on unquoted pipe and logical operators (|, ||, &&, |&).
 * Characters inside single or double quotes, or after a backslash escape,
 * are never treated as operators.
 */
function splitOnUnquotedOperators(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let i = 0;

  while (i < command.length) {
    const ch = command[i];

    // Backslash escape: consume next char literally
    if (ch === '\\' && i + 1 < command.length) {
      current += ch + command[i + 1];
      i += 2;
      continue;
    }

    // Track quote state
    if (ch === "'" && !inDouble) { inSingle = !inSingle; current += ch; i++; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; current += ch; i++; continue; }

    // Only match operators outside quotes
    if (!inSingle && !inDouble) {
      // ||
      if (ch === '|' && command[i + 1] === '|') {
        segments.push(current.trim());
        current = '';
        i += 2;
        continue;
      }
      // |&
      if (ch === '|' && command[i + 1] === '&') {
        segments.push(current.trim());
        current = '';
        i += 2;
        continue;
      }
      // |
      if (ch === '|') {
        segments.push(current.trim());
        current = '';
        i++;
        continue;
      }
      // &&
      if (ch === '&' && command[i + 1] === '&') {
        segments.push(current.trim());
        current = '';
        i += 2;
        continue;
      }
    }

    current += ch;
    i++;
  }

  segments.push(current.trim());
  return segments;
}

export function extractBashPatterns(command: string): string[] {
  // Strip shell comment lines (lines starting with optional whitespace + #)
  const withoutComments = command.split('\n')
    .filter(line => !/^\s*#/.test(line))
    .join('\n');

  // Strip chained `cd <path> &&` prefixes
  const stripped = withoutComments.replace(/^(?:cd\s+\S+\s*&&\s*)+/, '').trim();
  if (!stripped) return [];

  // Split on pipes and logical operators, respecting quoted strings
  const segments = splitOnUnquotedOperators(stripped);
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
 * Check if SDK-provided suggestions contain rules whose ruleContent starts with '#'
 * (i.e. the SDK extracted a shell comment as the pattern prefix).
 * When true, we prefer our own fallback pattern extraction which strips comments.
 */
function hasCommentPatterns(suggestions: unknown[]): boolean {
  for (const s of suggestions) {
    if (typeof s !== 'object' || s === null) continue;
    const rules = (s as Record<string, unknown>).rules;
    if (!Array.isArray(rules)) continue;
    for (const rule of rules) {
      if (typeof rule !== 'object' || rule === null) continue;
      const { ruleContent } = rule as Record<string, unknown>;
      if (typeof ruleContent === 'string' && ruleContent.startsWith('#')) return true;
    }
  }
  return false;
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
