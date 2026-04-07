import { describe, it, expect } from '@jest/globals';
import { formatCatalogForLLM } from '../../../src/commands/index';
import { defineCommand } from '../../../src/commands/types';
import type { CommandDefinition } from '../../../src/commands/types';

describe('formatCatalogForLLM()', () => {
  const testCommands: CommandDefinition[] = [
    defineCommand({
      name: 'model',
      description: 'Switch the Claude model',
      category: 'config',
      args: [{ name: 'model', description: 'Model name', required: false, type: 'enum', options: ['opus', 'sonnet'] }],
      handler: async () => ({ type: 'handled', reply: 'ok' }),
    }),
    defineCommand({
      name: 'clear',
      description: 'Clear session',
      category: 'workflow',
      handler: async () => ({ type: 'handled', reply: 'ok' }),
    }),
    defineCommand({
      name: 'review',
      description: 'Review a PR',
      category: 'git',
      sdkSlashCommand: true,
      args: [{ name: 'pr', description: 'PR number', required: false, type: 'string' }],
    }),
    defineCommand({
      name: 'interrupt',
      description: 'Interrupt execution',
      category: 'diagnostic',
      aliases: ['stop'],
      handler: async () => ({ type: 'handled', reply: 'ok' }),
    }),
  ];

  it('groups commands by category', () => {
    const catalog = formatCatalogForLLM(testCommands);
    expect(catalog).toContain('Configuration:');
    expect(catalog).toContain('Workflow:');
    expect(catalog).toContain('Code Review & Git:');
    expect(catalog).toContain('Diagnostics:');
  });

  it('formats command name and description', () => {
    const catalog = formatCatalogForLLM(testCommands);
    expect(catalog).toContain('!clear — Clear session');
  });

  it('includes optional args in brackets', () => {
    const catalog = formatCatalogForLLM(testCommands);
    expect(catalog).toContain('!model [model] — Switch the Claude model');
  });

  it('includes aliases', () => {
    const catalog = formatCatalogForLLM(testCommands);
    expect(catalog).toContain('(aliases: !stop)');
  });

  it('starts with header line', () => {
    const catalog = formatCatalogForLLM(testCommands);
    expect(catalog).toMatch(/^Available bot commands:/);
  });

  it('returns empty sections gracefully', () => {
    const catalog = formatCatalogForLLM([]);
    expect(catalog).toBe('Available bot commands:\n\n');
  });
});
