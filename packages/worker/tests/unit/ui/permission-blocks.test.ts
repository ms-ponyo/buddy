// tests/unit/ui/permission-blocks.test.ts
import {
  buildPermissionBlocks,
  classifyToolRisk,
  riskEmoji,
  shouldPreview,
} from '../../../src/ui/permission-blocks.js';

describe('classifyToolRisk', () => {
  it('classifies destructive bash commands', () => {
    expect(classifyToolRisk('Bash', { command: 'rm -rf /' })).toBe('destructive');
    expect(classifyToolRisk('Bash', { command: 'git push --force' })).toBe('destructive');
    expect(classifyToolRisk('Bash', { command: 'git reset --hard' })).toBe('destructive');
    expect(classifyToolRisk('Bash', { command: 'sudo apt install' })).toBe('destructive');
  });

  it('classifies info tools', () => {
    expect(classifyToolRisk('Read', {})).toBe('info');
    expect(classifyToolRisk('Grep', {})).toBe('info');
    expect(classifyToolRisk('Glob', {})).toBe('info');
    expect(classifyToolRisk('WebFetch', {})).toBe('info');
    expect(classifyToolRisk('WebSearch', {})).toBe('info');
  });

  it('classifies moderate tools', () => {
    expect(classifyToolRisk('Write', {})).toBe('moderate');
    expect(classifyToolRisk('Edit', {})).toBe('moderate');
    expect(classifyToolRisk('Bash', { command: 'ls -la' })).toBe('moderate');
    expect(classifyToolRisk('NotebookEdit', {})).toBe('moderate');
  });

  it('defaults to moderate for unknown tools', () => {
    expect(classifyToolRisk('SomeNewTool', {})).toBe('moderate');
  });
});

describe('riskEmoji', () => {
  it('returns correct emoji for each risk level', () => {
    expect(riskEmoji('destructive')).toBe(':rotating_light:');
    expect(riskEmoji('moderate')).toBe(':wrench:');
    expect(riskEmoji('info')).toBe(':mag:');
  });
});

describe('shouldPreview', () => {
  it('returns false when preview is off', () => {
    expect(shouldPreview('destructive', 'off')).toBe(false);
    expect(shouldPreview('moderate', 'off')).toBe(false);
  });

  it('previews only destructive when mode is destructive', () => {
    expect(shouldPreview('destructive', 'destructive')).toBe(true);
    expect(shouldPreview('moderate', 'destructive')).toBe(false);
    expect(shouldPreview('info', 'destructive')).toBe(false);
  });

  it('previews moderate and destructive when mode is moderate', () => {
    expect(shouldPreview('destructive', 'moderate')).toBe(true);
    expect(shouldPreview('moderate', 'moderate')).toBe(true);
    expect(shouldPreview('info', 'moderate')).toBe(false);
  });
});

describe('buildPermissionBlocks', () => {
  it('builds blocks for a tool with lock text and allow/deny buttons', () => {
    const result = buildPermissionBlocks({
      toolName: 'Bash',
      lockText: '`Bash` \u2192 `ls -la`',
      callbackId: 'perm-123',
      includeAlwaysAllow: false,
    });
    expect(result.text).toContain('Bash');
    expect(result.blocks).toBeDefined();
    expect(result.blocks.length).toBeGreaterThanOrEqual(2);

    const blocksJson = JSON.stringify(result.blocks);
    expect(blocksJson).toContain('perm-123');
    expect(blocksJson).toContain('permission_approve');
    expect(blocksJson).toContain('permission_deny');
  });

  it('includes Always button when includeAlwaysAllow is true', () => {
    const result = buildPermissionBlocks({
      toolName: 'Bash',
      lockText: '`Bash` \u2192 `*`',
      callbackId: 'perm-456',
      includeAlwaysAllow: true,
    });

    const blocksJson = JSON.stringify(result.blocks);
    expect(blocksJson).toContain('permission_always_allow');
    expect(blocksJson).toContain('\u2713 Always');
  });

  it('does not include Always button when includeAlwaysAllow is false', () => {
    const result = buildPermissionBlocks({
      toolName: 'Bash',
      lockText: 'test',
      callbackId: 'perm-789',
      includeAlwaysAllow: false,
    });

    const blocksJson = JSON.stringify(result.blocks);
    expect(blocksJson).not.toContain('permission_always_allow');
  });

  it('includes lock emoji and text in the section block', () => {
    const result = buildPermissionBlocks({
      toolName: 'Write',
      lockText: '`Write` \u2192 `/tmp/test.txt`',
      callbackId: 'perm-abc',
      includeAlwaysAllow: false,
    });

    const blocksJson = JSON.stringify(result.blocks);
    expect(blocksJson).toContain(':lock:');
    expect(blocksJson).toContain('`Write`');
  });
});
