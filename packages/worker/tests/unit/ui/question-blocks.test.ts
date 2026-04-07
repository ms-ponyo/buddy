// tests/unit/ui/question-blocks.test.ts
import { buildQuestionBlocks } from '../../../src/ui/question-blocks.js';

describe('buildQuestionBlocks', () => {
  it('builds blocks for a single question with options', () => {
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
  });

  it('builds blocks for multiple questions', () => {
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
    expect(blocksJson).toContain('Q2');
    expect(blocksJson).toContain('First question');
    expect(blocksJson).toContain('Second question');
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

  it('truncates long option labels to 75 chars', () => {
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
    // The label in the button should be truncated
    expect(blocksJson).not.toContain(longLabel);
    expect(blocksJson).toContain('A'.repeat(75));
  });

  it('includes correct action_id pattern with question and option indices', () => {
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
    expect(blocksJson).toContain('question_answer_0_0');
    expect(blocksJson).toContain('question_answer_0_1');
  });
});
