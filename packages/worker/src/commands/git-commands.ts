// src/commands/git-commands.ts — Code review & git commands.

import { defineCommand } from './types.js';
import type { CommandDefinition } from './types.js';

export const gitCommands: CommandDefinition[] = [
  // Handled commands: worktree, pr
  defineCommand({
    name: 'worktree',
    description: 'Create an isolated git worktree for this session',
    category: 'git',
    args: [{ name: 'name', description: 'Worktree name', required: false, type: 'string' }],
    examples: ['!worktree my-feature', '!worktree'],
    handler: async (args) => {
      const wtName = args || undefined;
      return {
        type: 'dispatch',
        reply: `User wants to create a git worktree${wtName ? ` named "${wtName}"` : ''}. Start a new session with the --worktree flag. Tell them you'll create an isolated worktree for their work.`,
      };
    },
  }),
  defineCommand({
    name: 'pr',
    description: 'Load a pull request context into the session',
    category: 'git',
    args: [{ name: 'pr', description: 'PR number or URL', required: false, type: 'string' }],
    examples: ['!pr 123', '!pr https://github.com/org/repo/pull/123'],
    handler: async (args) => {
      if (!args) {
        return {
          type: 'dispatch',
          reply: 'User typed !pr without a PR number or URL. They want to start a session from a pull request\'s context. Ask them for the PR number or URL.',
        };
      }
      return {
        type: 'dispatch',
        reply: `User wants to start a session from PR ${args}. Use the --from-pr flag to load the PR context. Help them get started.`,
      };
    },
  }),

  // SDK slash commands:
  defineCommand({ name: 'review', description: 'Review a pull request', category: 'git', sdkSlashCommand: true, args: [{ name: 'pr', description: 'PR number or URL', required: false, type: 'string' }], examples: ['!review', '!review 123'] }),
  defineCommand({ name: 'diff', description: 'View uncommitted changes and per-turn diffs', category: 'git', sdkSlashCommand: true }),
  defineCommand({ name: 'commit', description: 'Generate a commit message and commit changes', category: 'git', sdkSlashCommand: true, args: [{ name: 'flags', description: '--amend, --all', required: false, type: 'string' }] }),
  defineCommand({ name: 'pr_comments', description: 'View and respond to PR review comments', category: 'git', sdkSlashCommand: true }),
  defineCommand({ name: 'issue', description: 'View and work on GitHub issues', category: 'git', sdkSlashCommand: true, args: [{ name: 'issue', description: 'Issue number or URL', required: false, type: 'string' }] }),
  defineCommand({ name: 'security-review', description: 'Run a security-focused code review', category: 'git', sdkSlashCommand: true }),
];
