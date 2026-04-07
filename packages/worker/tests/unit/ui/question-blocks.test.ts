// tests/unit/ui/question-blocks.test.ts
import { buildQuestionBlocks } from '../../../src/ui/question-blocks.js';

describe('buildQuestionBlocks', () => {
  it('builds blocks for a single question with radio buttons', () => {
    const result = buildQuestionBlocks({
      requestId: 'req-001',
      questions: [
        {
          header: 'Pick a color',
          question: 'What is your favorite color?',
          options: [
            { label: 'Red', description: 'The color red' },
            { label: 'Blue', description: 'The color blue' },
          ],
          multiSelect: false,
        },
      ],
    });

    expect(result.text).toBe('Claude has a question for you');
    expect(result.blocks.length).toBeGreaterThanOrEqual(2);

    const blocksJson = JSON.stringify(result.blocks);
    expect(blocksJson).toContain('Pick a color');
    expect(blocksJson).toContain('What is your favorite color?');
    expect(blocksJson).toContain('Red');
    expect(blocksJson).toContain('Blue');
    expect(blocksJson).toContain('req-001');
    expect(blocksJson).toContain('radio_buttons');
  });

  it('only renders the first question when multiple are provided', () => {
    const result = buildQuestionBlocks({
      requestId: 'req-002',
      questions: [
        {
          header: 'Q1',
          question: 'First question',
          options: [{ label: 'Yes', description: '' }],
          multiSelect: false,
        },
        {
          header: 'Q2',
          question: 'Second question',
          options: [{ label: 'No', description: '' }],
          multiSelect: false,
        },
      ],
    });

    const blocksJson = JSON.stringify(result.blocks);
    expect(blocksJson).toContain('Q1');
    expect(blocksJson).toContain('First question');
    // Second question should NOT be in the same message
    expect(blocksJson).not.toContain('Q2');
    expect(blocksJson).not.toContain('Second question');
  });

  it('returns empty blocks for no questions', () => {
    const result = buildQuestionBlocks({
      requestId: 'req-empty',
      questions: [],
    });

    expect(result.blocks).toEqual([]);
  });

  it('includes text input block for custom answers', () => {
    const result = buildQuestionBlocks({
      requestId: 'req-003',
      questions: [
        {
          header: 'Title',
          question: 'Type something',
          options: [{ label: 'Option A', description: '' }],
          multiSelect: false,
        },
      ],
    });

    const blocksJson = JSON.stringify(result.blocks);
    expect(blocksJson).toContain('question_text_input');
    expect(blocksJson).toContain('Or type your answer');
  });

  it('preserves full option labels in radio buttons', () => {
    const longLabel = 'A'.repeat(100);
    const result = buildQuestionBlocks({
      requestId: 'req-004',
      questions: [
        {
          header: 'H',
          question: 'Q',
          options: [{ label: longLabel, description: '' }],
          multiSelect: false,
        },
      ],
    });

    const blocksJson = JSON.stringify(result.blocks);
    expect(blocksJson).toContain(longLabel);
  });

  it('uses radio_buttons with correct action_id', () => {
    const result = buildQuestionBlocks({
      requestId: 'req-005',
      questions: [
        {
          header: 'H',
          question: 'Q',
          options: [
            { label: 'Opt0', description: '' },
            { label: 'Opt1', description: '' },
          ],
          multiSelect: false,
        },
      ],
    });

    const blocksJson = JSON.stringify(result.blocks);
    expect(blocksJson).toContain('radio_buttons');
    expect(blocksJson).toContain('question_answer_0');
    // Both options should be in the same radio_buttons element
    expect(blocksJson).toContain('Opt0');
    expect(blocksJson).toContain('Opt1');
  });

  it('renders preview content as markdown blocks below radio buttons', () => {
    const result = buildQuestionBlocks({
      requestId: 'req-006',
      questions: [
        {
          header: 'Approach',
          question: 'Which implementation?',
          options: [
            { label: 'Option A', description: 'Simple', preview: '```ts\nconsole.log("A")\n```' },
            { label: 'Option B', description: 'Complex' },
          ],
          multiSelect: false,
        },
      ],
    });

    const blocksJson = JSON.stringify(result.blocks);
    // Should have a divider before previews
    expect(blocksJson).toContain('"type":"divider"');
    // Should have a markdown block for Option A's preview
    expect(blocksJson).toContain('"type":"markdown"');
    expect(blocksJson).toContain('**Option A**');
    expect(blocksJson).toContain('console.log');
    // Option B has no preview, should not appear in markdown blocks
    expect(blocksJson).not.toContain('**Option B**');
  });

  it('skips preview section when no options have previews', () => {
    const result = buildQuestionBlocks({
      requestId: 'req-007',
      questions: [
        {
          header: 'H',
          question: 'Q',
          options: [
            { label: 'A', description: 'desc A' },
            { label: 'B', description: 'desc B' },
          ],
          multiSelect: false,
        },
      ],
    });

    const blocksJson = JSON.stringify(result.blocks);
    expect(blocksJson).not.toContain('"type":"divider"');
    expect(blocksJson).not.toContain('"type":"markdown"');
  });

  it('uses checkboxes when multiSelect is true', () => {
    const result = buildQuestionBlocks({
      requestId: 'req-008',
      questions: [
        {
          header: 'Features',
          question: 'Which features?',
          options: [
            { label: 'Auth', description: '' },
            { label: 'Logging', description: '' },
          ],
          multiSelect: true,
        },
      ],
    });

    const blocksJson = JSON.stringify(result.blocks);
    expect(blocksJson).toContain('checkboxes');
    expect(blocksJson).not.toContain('radio_buttons');
  });

  it('includes description on radio options when provided', () => {
    const result = buildQuestionBlocks({
      requestId: 'req-009',
      questions: [
        {
          header: 'H',
          question: 'Q',
          options: [
            { label: 'A', description: 'Explanation of A' },
            { label: 'B', description: '' },
          ],
          multiSelect: false,
        },
      ],
    });

    const blocksJson = JSON.stringify(result.blocks);
    expect(blocksJson).toContain('Explanation of A');
  });
});
