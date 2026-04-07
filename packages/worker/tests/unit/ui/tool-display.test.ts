// tests/unit/ui/tool-display.test.ts
import {
  shortToolName,
  toolUseStatusText,
  getEditDiffBlocks,
  TOOL_DISPLAY,
} from '../../../src/ui/tool-display.js';

describe('shortToolName', () => {
  it('returns the tool name when no MCP prefix', () => {
    expect(shortToolName('Bash')).toBe('Bash');
    expect(shortToolName('Read')).toBe('Read');
  });

  it('strips MCP server prefix', () => {
    expect(shortToolName('mcp__playwright__browser_click')).toBe('browser_click');
    expect(shortToolName('mcp__server__tool_name')).toBe('tool_name');
  });

  it('handles double-underscore in tool name', () => {
    expect(shortToolName('mcp__a__b__c')).toBe('c');
  });
});

describe('toolUseStatusText', () => {
  it('formats Read tool', () => {
    const text = toolUseStatusText('Read', { file_path: '/tmp/test.ts' });
    expect(text).toContain(':mag:');
    expect(text).toContain('/tmp/test.ts');
  });

  it('formats Edit tool', () => {
    const text = toolUseStatusText('Edit', { file_path: '/tmp/test.ts' });
    expect(text).toContain(':pencil2:');
    expect(text).toContain('/tmp/test.ts');
  });

  it('formats Write tool', () => {
    const text = toolUseStatusText('Write', { file_path: '/tmp/new.ts' });
    expect(text).toContain(':pencil2:');
    expect(text).toContain('/tmp/new.ts');
  });

  it('formats Bash tool with command', () => {
    const text = toolUseStatusText('Bash', { command: 'npm test' });
    expect(text).toContain(':computer:');
    expect(text).toContain('npm test');
  });

  it('formats Bash tool without command', () => {
    const text = toolUseStatusText('Bash', {});
    expect(text).toContain(':computer:');
    expect(text).toContain('Running command...');
  });

  it('formats Grep tool', () => {
    const text = toolUseStatusText('Grep', { pattern: 'TODO' });
    expect(text).toContain(':mag:');
    expect(text).toContain('TODO');
  });

  it('formats Glob tool', () => {
    const text = toolUseStatusText('Glob', {});
    expect(text).toContain(':mag:');
    expect(text).toContain('Finding files');
  });

  it('formats Agent tool', () => {
    const text = toolUseStatusText('Agent', {});
    expect(text).toContain(':robot_face:');
    expect(text).toContain('Spawning agent');
  });

  it('formats WebFetch tool', () => {
    const text = toolUseStatusText('WebFetch', { url: 'https://example.com' });
    expect(text).toContain(':globe_with_meridians:');
    expect(text).toContain('https://example.com');
  });

  it('formats WebSearch tool', () => {
    const text = toolUseStatusText('WebSearch', {});
    expect(text).toContain(':globe_with_meridians:');
  });

  it('formats Skill tool', () => {
    const text = toolUseStatusText('Skill', { skill: 'pdf' });
    expect(text).toContain(':sparkles:');
    expect(text).toContain('pdf');
  });

  it('formats browser tools via TOOL_DISPLAY map', () => {
    const text = toolUseStatusText('mcp__playwright__browser_click', {});
    expect(text).toContain(':point_up:');
    expect(text).toContain('Clicking element');
  });

  it('formats unknown tools with gear emoji', () => {
    const text = toolUseStatusText('mcp__custom__some_action', {});
    expect(text).toContain(':gear:');
    expect(text).toContain('Some action');
  });

  it('includes elapsed time when provided', () => {
    const text = toolUseStatusText('Bash', { command: 'sleep 5' }, 3);
    expect(text).toContain('(3s)');
  });

  it('omits elapsed time when less than 1 second', () => {
    const text = toolUseStatusText('Bash', { command: 'echo hi' }, 0.5);
    expect(text).not.toContain('s)');
  });

  it('handles missing file_path gracefully', () => {
    const text = toolUseStatusText('Read', {});
    expect(text).toContain('file');
  });
});

describe('TOOL_DISPLAY', () => {
  it('contains entries for common browser tools', () => {
    expect(TOOL_DISPLAY.has('browser_navigate')).toBe(true);
    expect(TOOL_DISPLAY.has('browser_take_screenshot')).toBe(true);
    expect(TOOL_DISPLAY.has('browser_click')).toBe(true);
    expect(TOOL_DISPLAY.has('browser_close')).toBe(true);
  });
});

describe('getEditDiffBlocks', () => {
  it('returns diff blocks for old and new strings', () => {
    const blocks = getEditDiffBlocks({
      file_path: '/tmp/test.ts',
      old_string: 'const a = 1;',
      new_string: 'const a = 2;',
    });
    expect(blocks.length).toBeGreaterThanOrEqual(1);
  });

  it('returns empty array when both strings are empty', () => {
    const blocks = getEditDiffBlocks({
      file_path: '/tmp/test.ts',
      old_string: '',
      new_string: '',
    });
    expect(blocks).toEqual([]);
  });

  it('strips projectDir prefix from file path', () => {
    const blocks = getEditDiffBlocks(
      {
        file_path: '/home/user/project/src/file.ts',
        old_string: 'a',
        new_string: 'b',
      },
      '/home/user/project',
    );
    const blocksJson = JSON.stringify(blocks);
    expect(blocksJson).toContain('src/file.ts');
    expect(blocksJson).not.toContain('/home/user/project/src/file.ts');
  });

  it('handles missing file_path gracefully', () => {
    const blocks = getEditDiffBlocks({
      file_path: '',
      old_string: 'a',
      new_string: 'b',
    });
    // Should not throw, returns some blocks
    expect(blocks).toBeDefined();
  });
});
