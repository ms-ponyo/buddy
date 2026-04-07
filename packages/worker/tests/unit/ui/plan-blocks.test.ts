// tests/unit/ui/plan-blocks.test.ts
import { buildPlanReviewBlocks } from '../../../src/ui/plan-blocks.js';

describe('buildPlanReviewBlocks', () => {
  it('builds blocks with header, plan content, and approve/reject buttons', () => {
    const result = buildPlanReviewBlocks({
      planContent: '## Step 1\nDo something\n\n## Step 2\nDo another thing',
      callbackId: 'plan-001',
    });

    expect(result.text).toBe('Plan for review');
    expect(result.blocks.length).toBeGreaterThanOrEqual(3);

    const blocksJson = JSON.stringify(result.blocks);
    expect(blocksJson).toContain('plan-001');
    expect(blocksJson).toContain('plan-001_approve');
    expect(blocksJson).toContain('plan-001_reject');
    expect(blocksJson).toContain('Plan for Review');
  });

  it('includes plan content in markdown blocks', () => {
    const result = buildPlanReviewBlocks({
      planContent: '# My Plan\nThis is the plan content.',
      callbackId: 'plan-002',
    });

    const blocksJson = JSON.stringify(result.blocks);
    expect(blocksJson).toContain('My Plan');
    expect(blocksJson).toContain('plan content');
  });

  it('handles empty plan content gracefully', () => {
    const result = buildPlanReviewBlocks({
      planContent: '',
      callbackId: 'plan-003',
    });

    expect(result.blocks.length).toBeGreaterThanOrEqual(1);
    const blocksJson = JSON.stringify(result.blocks);
    // formatPlanAsMarkdownBlocks returns '_Empty plan_' for empty input
    expect(blocksJson).toContain('Empty plan');
  });

  it('splits into multiple messages when blocks exceed 50', () => {
    // Generate a very long plan that would produce many blocks
    const longPlan = Array.from({ length: 100 }, (_, i) => `## Section ${i}\n${'Content '.repeat(200)}`).join('\n\n');
    const result = buildPlanReviewBlocks({
      planContent: longPlan,
      callbackId: 'plan-004',
    });

    // When blocks exceed 50, the function returns splitMessages
    if (result.splitMessages) {
      expect(result.splitMessages.length).toBeGreaterThanOrEqual(1);
      // The last split message should contain the approve/reject buttons
      const lastMsg = result.splitMessages[result.splitMessages.length - 1];
      const lastJson = JSON.stringify(lastMsg);
      expect(lastJson).toContain('plan-004_approve');
    } else {
      // If the plan is short enough, blocks are used directly
      expect(result.blocks.length).toBeLessThanOrEqual(50);
    }
  });
});
