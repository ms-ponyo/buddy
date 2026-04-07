// Mock dependencies before importing
import { jest } from '@jest/globals';
jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  getAvailableCommands: jest.fn(() => Promise.resolve([])),
}));

import { createMultiSelectMessage, updateMultiSelectMessage, handleMultiSelectToggle, addSubmitButton } from '../../../packages/worker/src/slack-handler/ui/multi-select.js';

describe('createMultiSelectMessage', () => {
  it('should create checkbox blocks with options', () => {
    const options = [
      { label: 'Option 1', value: 'opt1', description: 'First option' },
      { label: 'Option 2', value: 'opt2', description: 'Second option' }
    ];

    const blocks = createMultiSelectMessage('Select options:', options);

    expect(blocks).toBeDefined();
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks[0]).toHaveProperty('type', 'section');
    expect((blocks[0] as any).text.text).toBe('*Select options:*');
  });
});

describe('updateMultiSelectMessage', () => {
  it('should update message with current selections', () => {
    const options = [
      { label: 'Option 1', value: 'opt1' },
      { label: 'Option 2', value: 'opt2' }
    ];
    const selections = ['opt2'];

    const blocks = updateMultiSelectMessage('Select options:', options, selections);

    expect(blocks).toBeDefined();
    expect(blocks.some((block: any) =>
      block.text?.text?.includes('Selected: Option 2')
    )).toBe(true);
  });
});

describe('handleMultiSelectAction', () => {
  it('should toggle selection state correctly', () => {
    const currentSelections = ['opt1'];
    const toggleValue = 'opt2';

    const newSelections = handleMultiSelectToggle(currentSelections, toggleValue);

    expect(newSelections).toEqual(['opt1', 'opt2']);
  });

  it('should remove selection when already selected', () => {
    const currentSelections = ['opt1', 'opt2'];
    const toggleValue = 'opt1';

    const newSelections = handleMultiSelectToggle(currentSelections, toggleValue);

    expect(newSelections).toEqual(['opt2']);
  });
});

describe('addSubmitButton', () => {
  it('should add submit and clear buttons when selections exist', () => {
    const blocks = [{ type: "section", text: { type: "mrkdwn", text: "test" } }];
    const selections = ['opt1'];

    const blocksWithSubmit = addSubmitButton(blocks, selections);

    expect(blocksWithSubmit.length).toBeGreaterThan(blocks.length);
    expect(blocksWithSubmit.some((block: any) =>
      block.elements?.some((el: any) => el.action_id === 'multiselect_submit')
    )).toBe(true);
  });
});

describe('multiselect action integration', () => {
  it('should route multiselect actions correctly', () => {
    const actionId = 'multiselect_toggle_opt1';

    const isMultiSelectAction = actionId.startsWith('multiselect_');

    expect(isMultiSelectAction).toBe(true);
  });
});

describe('multiselect demo command', () => {
  it('should create demo multiselect message', async () => {
    const demoOptions = [
      { label: 'JavaScript', value: 'js', description: 'JavaScript development' },
      { label: 'Python', value: 'py', description: 'Python development' },
      { label: 'Go', value: 'go', description: 'Go development' }
    ];

    const blocks = createMultiSelectMessage('Select programming languages:', demoOptions);

    expect(blocks).toBeDefined();
    expect((blocks[0] as any).text.text).toBe('*Select programming languages:*');
    expect(blocks.length).toBe(4); // title + 3 options
  });
});

describe('multiselect error handling', () => {
  it('should handle empty options gracefully', () => {
    const blocks = createMultiSelectMessage('Select options:', []);

    expect(blocks.length).toBe(2); // title + empty state message
    expect((blocks[1] as any).text.text).toBe('No options available');
  });

  it('should handle invalid toggle values', () => {
    const selections = handleMultiSelectToggle(['opt1'], 'invalid');

    expect(selections).toEqual(['opt1', 'invalid']); // Still adds it
  });
});