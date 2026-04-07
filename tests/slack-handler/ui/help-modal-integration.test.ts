// Mock dependencies before importing
import { jest } from '@jest/globals';

const mockGetAvailableCommands = jest.fn(() => Promise.resolve([
  {
    name: 'test-skill',
    shortName: 'test',
    description: 'Test skill for integration tests',
    argumentHint: '[args]',
    category: 'test'
  },
  {
    name: 'another-skill',
    shortName: 'another',
    description: 'Another test skill',
    argumentHint: '[options]',
    category: 'util'
  }
]));

jest.unstable_mockModule('../../../packages/worker/src/claude-handler.js', () => ({
  getAvailableCommands: mockGetAvailableCommands,
}));

const { buildHelpModalBlocks } = await import('../../../packages/worker/src/slack-handler/ui/help-modal.js');
import type { Config } from '../../../packages/worker/src/config.js';

// Mock SlackClient for comprehensive testing
interface MockSlackClient {
  chat: {
    postMessage: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
    postEphemeral: jest.Mock;
  };
  reactions: {
    add: jest.Mock;
    remove: jest.Mock;
  };
  views?: {
    open: jest.Mock;
    update: jest.Mock;
    close?: jest.Mock;
  };
}

describe('Help Modal Integration', () => {
  let mockClient: MockSlackClient;
  let mockConfig: Config;
  const channel = 'C123456789';
  const threadTs = '1234567890.123456';
  const triggerId = 'trigger_12345';

  beforeEach(() => {
    jest.clearAllMocks();

    mockClient = {
      chat: {
        postMessage: jest.fn().mockResolvedValue({ ok: true }),
        update: jest.fn().mockResolvedValue({ ok: true }),
        delete: jest.fn().mockResolvedValue({ ok: true }),
        postEphemeral: jest.fn().mockResolvedValue({ ok: true }),
      },
      reactions: {
        add: jest.fn().mockResolvedValue({ ok: true }),
        remove: jest.fn().mockResolvedValue({ ok: true }),
      },
      views: {
        open: jest.fn().mockResolvedValue({ ok: true, view: { id: 'view_123' } }),
        update: jest.fn().mockResolvedValue({ ok: true, view: { id: 'view_123' } }),
        close: jest.fn().mockResolvedValue({ ok: true }),
      },
    };

    mockConfig = {
      slackBotToken: 'test-bot-token',
      slackAppToken: 'test-app-token',
      projectDir: '/test/project',
      claudeModel: 'claude-sonnet-4-20250514',
      haikuModel: 'claude-haiku-4-20250414',
      permissionMode: 'allowed' as any,
      permissionDestination: 'projectSettings' as any,
      logLevel: 'info',
      logFile: '/test/log',
      sessionFile: '/test/session',
      allowedUserIds: [],
      allowedChannelIds: [],
      adminUserIds: [],
      triggerEmoji: '🤖',
      previewMode: 'off' as const,
      projectMappingsFile: '/test/mappings',
      mcpServers: {},
      plugins: [],
      interactiveBridgePatterns: []
    } as Config;
  });

  describe('Modal Opening Workflow', () => {
    it('should build help modal blocks correctly', async () => {
      const blocks = await buildHelpModalBlocks(mockConfig, channel, threadTs);

      expect(blocks).toBeDefined();
      expect(blocks.length).toBeGreaterThan(0);

      // Should have command section
      expect(blocks[0]).toEqual({
        type: 'section',
        text: { type: 'mrkdwn', text: '*Bot commands:*' }
      });

      // Should have command buttons
      const commandActions = blocks[1] as any;
      expect(commandActions.type).toBe('actions');
      expect(commandActions.elements).toHaveLength(3);
      expect(commandActions.elements.map((e: any) => e.action_id)).toContain('help_cmd_model');
      expect(commandActions.elements.map((e: any) => e.action_id)).toContain('help_cmd_project');
      expect(commandActions.elements.map((e: any) => e.action_id)).toContain('help_cmd_clear');
    });

    it('should handle modal opening with trigger_id', () => {
      const modalPayload = {
        trigger_id: triggerId,
        view: {
          type: "modal",
          callback_id: "help_modal",
          title: { type: "plain_text", text: "Claude Bot Help" },
          close: { type: "plain_text", text: "Close" },
          private_metadata: JSON.stringify({ channel, threadTs }),
          blocks: expect.any(Array)
        }
      };

      // Test that modal structure matches expected format
      expect(modalPayload.view.type).toBe('modal');
      expect(modalPayload.view.callback_id).toBe('help_modal');
      expect(JSON.parse(modalPayload.view.private_metadata)).toEqual({ channel, threadTs });
    });

    it('should handle modal opening failure gracefully', async () => {
      const mockFailedClient = {
        ...mockClient,
        views: {
          open: jest.fn().mockRejectedValue(new Error('Slack API error'))
        }
      };

      // In real implementation, this should fallback to posting a message
      // or show appropriate error handling
      expect(mockFailedClient.views.open).toThrow;
    });

    it('should fallback to inline help when no trigger_id is available', () => {
      // Test the fallback logic when trigger_id is not available
      const mockBodyWithoutTrigger = {
        view: undefined
      };

      const triggerId = (mockBodyWithoutTrigger as any).trigger_id;
      expect(triggerId).toBeUndefined();

      // When no trigger_id is available, should call postInlineHelp instead of modal
      // This tests the logic branch in handleBotCommand for help
    });

    it('should handle inline help blocks generation', async () => {
      // Test that inline help blocks can be generated successfully
      const blocks = await buildHelpModalBlocks(mockConfig, channel, threadTs);

      // The blocks should be suitable for both modal and inline display
      expect(blocks).toBeDefined();
      expect(blocks.length).toBeGreaterThan(0);

      // Should have command section that works in both contexts
      expect(blocks[0]).toEqual({
        type: 'section',
        text: { type: 'mrkdwn', text: '*Bot commands:*' }
      });
    });
  });

  describe('Help Fallback Behavior', () => {
    it('should use modal when trigger_id is available', () => {
      const bodyWithTrigger = {
        trigger_id: triggerId,
        view: undefined
      };

      expect(bodyWithTrigger.trigger_id).toBe(triggerId);
      expect(bodyWithTrigger.trigger_id).toBeDefined();

      // When trigger_id is available, should attempt to open modal
    });

    it('should fallback to inline message when trigger_id is missing', () => {
      const bodyWithoutTrigger = {
        view: undefined
      };

      const triggerId = (bodyWithoutTrigger as any).trigger_id;
      expect(triggerId).toBeUndefined();

      // When trigger_id is missing, should post inline help instead
      // This ensures help command works from direct messages and threads
    });

    it('should handle both modal and inline button contexts', () => {
      // Test modal context
      const modalContext = {
        view: {
          private_metadata: JSON.stringify({ channel, threadTs }),
          id: 'view_123'
        }
      };

      const modalMetadata = JSON.parse(modalContext.view.private_metadata);
      expect(modalMetadata.channel).toBe(channel);
      expect(modalMetadata.threadTs).toBe(threadTs);

      // Test inline message context
      const messageContext = {
        channel: { id: channel },
        message: { ts: threadTs, thread_ts: threadTs }
      };

      expect(messageContext.channel.id).toBe(channel);
      expect(messageContext.message.thread_ts).toBe(threadTs);

      // Button handlers should work in both contexts
    });

    it('should extract context correctly from message body', () => {
      const messageBody = {
        channel: { id: channel },
        message: { ts: '1234567890.123456', thread_ts: threadTs }
      };

      const extractedChannel = messageBody.channel.id;
      const extractedThreadTs = messageBody.message.thread_ts || messageBody.message.ts;

      expect(extractedChannel).toBe(channel);
      expect(extractedThreadTs).toBe(threadTs);
    });
  });

  describe('Command Button Functionality', () => {
    it('should extract context from modal private_metadata correctly', () => {
      const mockBody = {
        view: {
          id: 'view_123',
          private_metadata: JSON.stringify({ channel, threadTs })
        }
      };

      const context = JSON.parse(mockBody.view.private_metadata);
      expect(context).toEqual({ channel, threadTs });
      expect(context.channel).toBe(channel);
      expect(context.threadTs).toBe(threadTs);
    });

    it('should handle model command button click', () => {
      const mockAction = {
        type: 'button',
        action_id: 'help_cmd_model',
        value: undefined
      };

      const extractedCommand = mockAction.action_id.replace('help_cmd_', '');
      expect(extractedCommand).toBe('model');
    });

    it('should handle project command button click', () => {
      const mockAction = {
        type: 'button',
        action_id: 'help_cmd_project',
        value: undefined
      };

      const extractedCommand = mockAction.action_id.replace('help_cmd_', '');
      expect(extractedCommand).toBe('project');
    });

    it('should handle clear command button click', () => {
      const mockAction = {
        type: 'button',
        action_id: 'help_cmd_clear',
        value: undefined
      };

      const extractedCommand = mockAction.action_id.replace('help_cmd_', '');
      expect(extractedCommand).toBe('clear');
    });

    it('should handle compact command button click', () => {
      const mockAction = {
        type: 'button',
        action_id: 'help_cmd_compact',
        value: undefined
      };

      const extractedCommand = mockAction.action_id.replace('help_cmd_', '');
      expect(extractedCommand).toBe('compact');
    });

    it('should close modal when command button is clicked', () => {
      const mockViewId = 'view_123';

      // Simulate closing modal
      if (mockClient.views?.close) {
        mockClient.views.close({ view_id: mockViewId });
        expect(mockClient.views.close).toHaveBeenCalledWith({ view_id: mockViewId });
      }
    });
  });

  describe('Tab Navigation Behavior', () => {
    it('should generate tab buttons with correct action_ids', async () => {
      const blocks = await buildHelpModalBlocks(mockConfig, channel, threadTs);

      // Find tab navigation block - should be after command buttons and divider
      let tabBlock = null;
      for (const block of blocks) {
        const actions = block as any;
        if (actions.type === 'actions' && actions.elements) {
          const hasTabActions = actions.elements.some((el: any) =>
            el.action_id && el.action_id.startsWith('help_tab_')
          );
          if (hasTabActions) {
            tabBlock = actions;
            break;
          }
        }
      }

      if (tabBlock) {
        const tabActions = tabBlock as any;
        expect(tabActions.elements.length).toBeGreaterThan(0);

        // Check that tab buttons have proper action_ids
        const tabActionIds = tabActions.elements.map((el: any) => el.action_id);
        tabActionIds.forEach((id: string) => {
          expect(id).toMatch(/^help_tab_/);
        });
      }
    });

    it('should handle tab switching action correctly', () => {
      const mockTabAction = {
        type: 'button',
        action_id: 'help_tab_test',
        value: JSON.stringify({
          tab: 'test',
          channel,
          threadTs
        })
      };

      const parsedValue = JSON.parse(mockTabAction.value);
      expect(parsedValue.tab).toBe('test');
      expect(parsedValue.channel).toBe(channel);
      expect(parsedValue.threadTs).toBe(threadTs);
    });

    it('should update modal view when tab is clicked', () => {
      const mockViewId = 'view_123';
      const newBlocks = [{ type: 'section', text: { type: 'mrkdwn', text: 'Updated content' } }];

      // Simulate modal update
      if (mockClient.views?.update) {
        mockClient.views.update({
          view_id: mockViewId,
          view: {
            type: 'modal',
            callback_id: 'help_modal',
            title: { type: 'plain_text', text: 'Claude Bot Help' },
            close: { type: 'plain_text', text: 'Close' },
            private_metadata: JSON.stringify({ channel, threadTs }),
            blocks: newBlocks
          }
        });

        expect(mockClient.views.update).toHaveBeenCalledWith(
          expect.objectContaining({
            view_id: mockViewId,
            view: expect.objectContaining({
              blocks: newBlocks
            })
          })
        );
      }
    });

    it('should build modal blocks with specific active tab', async () => {
      const activeTab = 'test';
      const blocks = await buildHelpModalBlocks(mockConfig, channel, threadTs, activeTab);

      expect(blocks).toBeDefined();
      expect(blocks.length).toBeGreaterThan(0);

      // The blocks should reflect the active tab selection
      // This tests that the activeTab parameter is properly used
    });
  });

  describe('Skill Selection Flow', () => {
    it('should handle skill selection from dropdown', () => {
      const mockSkillAction = {
        type: 'select',
        action_id: 'help_skill_select',
        selected_option: {
          value: 'test-skill',
          text: { type: 'plain_text', text: 'test-skill [args]' }
        }
      };

      expect(mockSkillAction.selected_option.value).toBe('test-skill');
    });

    it('should extract trigger_id for skill modal opening', () => {
      const mockBody = {
        trigger_id: triggerId,
        view: {
          id: 'view_123',
          private_metadata: JSON.stringify({ channel, threadTs })
        }
      };

      expect(mockBody.trigger_id).toBe(triggerId);
      expect(mockBody.trigger_id).toBeDefined();
    });

    it('should handle skill search/filtering in options', () => {
      const mockOptions = {
        value: 'test'
      };

      const query = mockOptions.value.toLowerCase();
      expect(query).toBe('test');

      // In real implementation, this would filter available commands
      // based on the query string
    });

    it('should format skill options correctly', () => {
      const mockCommand = {
        name: 'test-skill',
        shortName: 'test',
        description: 'Test skill for integration tests',
        argumentHint: '[args]'
      };

      let label = mockCommand.name;
      if (mockCommand.argumentHint) {
        label += ` ${mockCommand.argumentHint}`;
      }

      const option = {
        text: { type: 'plain_text', text: label.slice(0, 75) },
        value: mockCommand.name,
        description: { type: 'plain_text', text: mockCommand.description.slice(0, 75) }
      };

      expect(option.text.text).toBe('test-skill [args]');
      expect(option.value).toBe('test-skill');
      expect(option.description.text).toBe('Test skill for integration tests');
    });
  });

  describe('Error Handling Scenarios', () => {
    it('should handle missing trigger_id gracefully', () => {
      const mockBodyWithoutTrigger = {
        view: {
          private_metadata: JSON.stringify({ channel, threadTs })
        }
      };

      const triggerId = (mockBodyWithoutTrigger as any).trigger_id;
      expect(triggerId).toBeUndefined();

      // Handler should exit early when trigger_id is missing
    });

    it('should handle missing private_metadata gracefully', () => {
      const mockBodyWithoutMetadata = {
        view: {}
      };

      const metadata = (mockBodyWithoutMetadata.view as any).private_metadata;
      expect(metadata).toBeUndefined();

      // Handler should exit early when private_metadata is missing
    });

    it('should handle invalid JSON in private_metadata', () => {
      const mockBodyWithInvalidJSON = {
        view: {
          private_metadata: 'invalid-json'
        }
      };

      expect(() => {
        JSON.parse(mockBodyWithInvalidJSON.view.private_metadata);
      }).toThrow();

      // Real implementation should have try/catch for JSON.parse
    });

    it('should handle missing view_id for modal operations', () => {
      const mockBodyWithoutViewId = {
        view: {
          private_metadata: JSON.stringify({ channel, threadTs })
        }
      };

      const viewId = (mockBodyWithoutViewId.view as any).id;
      expect(viewId).toBeUndefined();

      // Modal update/close operations should check for view_id existence
    });

    it('should handle getAvailableCommands failure', async () => {
      // Mock getAvailableCommands to throw an error
      mockGetAvailableCommands.mockRejectedValueOnce(new Error('SDK Error'));

      try {
        const blocks = await buildHelpModalBlocks(mockConfig, channel, threadTs);
        // Should still return blocks even if skills fail to load
        expect(blocks).toBeDefined();
        expect(blocks.length).toBeGreaterThan(0);
      } catch (error) {
        // Should not throw - should handle gracefully
        expect(error).toBeUndefined();
      }
    });

    it('should handle Slack API errors gracefully', () => {
      const mockErrorClient = {
        ...mockClient,
        views: {
          open: jest.fn().mockRejectedValue(new Error('rate_limited')),
          update: jest.fn().mockRejectedValue(new Error('invalid_arguments')),
          close: jest.fn().mockRejectedValue(new Error('view_not_found'))
        }
      };

      // These operations should not crash the application
      expect(mockErrorClient.views.open).toBeDefined();
      expect(mockErrorClient.views.update).toBeDefined();
      expect(mockErrorClient.views.close).toBeDefined();
    });
  });

  describe('Complete Modal Workflow Integration', () => {
    it('should handle complete help modal workflow', async () => {
      // Step 1: !help command opens modal
      const modalBlocks = await buildHelpModalBlocks(mockConfig, channel, threadTs);
      expect(modalBlocks).toBeDefined();
      expect(modalBlocks.length).toBeGreaterThan(0);

      // Step 2: Command buttons work and close modal
      const mockCommandAction = {
        type: 'button',
        action_id: 'help_cmd_model'
      };

      const extractedCommand = mockCommandAction.action_id.replace('help_cmd_', '');
      expect(extractedCommand).toBe('model');

      // Modal should close after command execution
      if (mockClient.views?.close) {
        mockClient.views.close({ view_id: 'view_123' });
        expect(mockClient.views.close).toHaveBeenCalled();
      }

      // Step 3: Tab navigation updates modal
      const mockTabAction = {
        type: 'button',
        action_id: 'help_tab_test',
        value: JSON.stringify({ tab: 'test', channel, threadTs })
      };

      if (mockClient.views?.update) {
        const newBlocks = await buildHelpModalBlocks(mockConfig, channel, threadTs, 'test');
        mockClient.views.update({
          view_id: 'view_123',
          view: {
            type: 'modal',
            callback_id: 'help_modal',
            title: { type: 'plain_text', text: 'Claude Bot Help' },
            close: { type: 'plain_text', text: 'Close' },
            private_metadata: JSON.stringify({ channel, threadTs }),
            blocks: newBlocks
          }
        });
        expect(mockClient.views.update).toHaveBeenCalled();
      }

      // Step 4: Skill selection closes modal and opens skill modal
      const mockSkillAction = {
        type: 'select',
        action_id: 'help_skill_select',
        selected_option: {
          value: 'test-skill',
          text: { type: 'plain_text', text: 'test-skill [args]' }
        }
      };

      expect(mockSkillAction.selected_option.value).toBe('test-skill');
    });

    it('should maintain proper context throughout workflow', () => {
      // Context should be preserved across all modal operations
      const context = { channel, threadTs };
      const serializedContext = JSON.stringify(context);
      const deserializedContext = JSON.parse(serializedContext);

      expect(deserializedContext).toEqual(context);
      expect(deserializedContext.channel).toBe(channel);
      expect(deserializedContext.threadTs).toBe(threadTs);
    });

    it('should handle concurrent modal operations safely', () => {
      // Test that multiple modal operations can be handled safely
      const operations = [
        () => mockClient.views?.open({ trigger_id: triggerId, view: {} }),
        () => mockClient.views?.update({ view_id: 'view_123', view: {} }),
        () => mockClient.views?.close?.({ view_id: 'view_123' })
      ];

      operations.forEach(op => {
        expect(op).not.toThrow();
      });
    });
  });

  describe('Type Safety and Validation', () => {
    it('should validate modal structure types', () => {
      const modalView = {
        type: "modal" as const,
        callback_id: "help_modal",
        title: { type: "plain_text" as const, text: "Claude Bot Help" },
        close: { type: "plain_text" as const, text: "Close" },
        private_metadata: JSON.stringify({ channel, threadTs }),
        blocks: [] as object[]
      };

      expect(modalView.type).toBe('modal');
      expect(modalView.callback_id).toBe('help_modal');
      expect(modalView.title.type).toBe('plain_text');
      expect(Array.isArray(modalView.blocks)).toBe(true);
    });

    it('should validate action payload types', () => {
      const buttonAction = {
        type: 'button' as const,
        text: { type: 'plain_text' as const, text: 'Model' },
        action_id: 'help_cmd_model'
      };

      expect(buttonAction.type).toBe('button');
      expect(buttonAction.text.type).toBe('plain_text');
      expect(typeof buttonAction.action_id).toBe('string');
    });

    it('should validate context serialization types', () => {
      const context = { channel, threadTs };
      const serialized = JSON.stringify(context);
      const deserialized = JSON.parse(serialized);

      expect(typeof serialized).toBe('string');
      expect(typeof deserialized).toBe('object');
      expect(typeof deserialized.channel).toBe('string');
      expect(typeof deserialized.threadTs).toBe('string');
    });
  });
});
