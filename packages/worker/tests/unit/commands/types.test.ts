import { describe, it, expect } from '@jest/globals';
import { defineCommand } from '../../../src/commands/types';
import type { CommandDefinition } from '../../../src/commands/types';

describe('defineCommand()', () => {
  it('returns a handled command definition unchanged', () => {
    const def = defineCommand({
      name: 'test',
      description: 'A test command',
      category: 'config',
      handler: async () => ({ type: 'handled', reply: 'ok' }),
    });
    expect(def.name).toBe('test');
    expect(def.description).toBe('A test command');
    expect(def.category).toBe('config');
    expect(def.handler).toBeDefined();
  });

  it('returns an SDK command definition unchanged', () => {
    const def = defineCommand({
      name: 'review',
      description: 'Review a PR',
      category: 'git',
      sdkSlashCommand: true,
    });
    expect(def.name).toBe('review');
    expect(def.sdkSlashCommand).toBe(true);
    expect(def).not.toHaveProperty('handler');
  });

  it('preserves optional metadata fields', () => {
    const def = defineCommand({
      name: 'model',
      description: 'Switch model',
      category: 'config',
      aliases: ['m'],
      args: [{ name: 'model', description: 'Model name', required: false, type: 'enum', options: ['opus', 'sonnet'] }],
      examples: ['!model opus'],
      noArgBehavior: 'dispatch',
      handler: async () => ({ type: 'handled', reply: 'ok' }),
    });
    expect(def.aliases).toEqual(['m']);
    expect(def.args).toHaveLength(1);
    expect(def.args![0].options).toEqual(['opus', 'sonnet']);
    expect(def.examples).toEqual(['!model opus']);
    expect(def.noArgBehavior).toBe('dispatch');
  });
});
