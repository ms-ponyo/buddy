import type { App } from '@slack/bolt';
import { WebClient } from '@slack/web-api';
import type { PromptDisplay } from '@buddy/shared';
import { RpcServer, GATEWAY_SOCKET } from '@buddy/shared';
import type { Logger } from './logger.js';
import type { SessionRegistry } from './session-registry.js';
import type { WorkerManager } from './worker-manager.js';

/**
 * IpcGateway — RPC-based gateway for worker ↔ Slack communication.
 *
 * Provides an RPC server on GATEWAY_SOCKET that workers connect to for:
 *   - slack.apiCall: proxy Slack Web API calls
 *
 * Also exports `postInteractivePromptToSlack` as a standalone helper.
 */
export class IpcGateway {
  /** Cached team ID from auth.test — used as fallback for stream recipient_team_id */
  private cachedTeamId: string | undefined;

  /** Cached bot user ID from auth.test — used as fallback for stream recipient_user_id */
  private cachedBotUserId: string | undefined;

  /** Separate WebClient using user token (xoxp-) for search API */
  private userClient: WebClient | undefined;

  /** The RPC server workers connect to */
  readonly server: RpcServer;

  constructor(
    private app: App,
    private registry: SessionRegistry,
    private logger: Logger,
    private workerManager?: WorkerManager,
    private slackUserToken?: string,
  ) {
    if (slackUserToken) {
      this.userClient = new WebClient(slackUserToken);
      logger.info('User token configured — search API available');
    }
    this.server = new RpcServer({
      socketPath: GATEWAY_SOCKET,
      onConnect: (_socket, clientId) => {
        logger.info(`Worker connected to gateway RPC server`, { clientId });
      },
      onDisconnect: (clientId) => {
        logger.info(`Worker disconnected from gateway RPC server`, { clientId });
      },
    });

    this.registerMethods();
  }

  private registerMethods(): void {
    // Slack API proxying (ephemeral operations)
    this.server.registerMethod('slack.apiCall', async (params) => {
      const { method, args } = params as { method: string; args: Record<string, unknown> };

      // Route search.* methods to user-token client (bot tokens can't search)
      const client = method.startsWith('search.') ? this.userClient : undefined;
      if (method.startsWith('search.') && !client) {
        throw new Error('Search API requires SLACK_USER_TOKEN to be configured');
      }

      // Resolve method path: 'chat.postMessage' → app.client.chat.postMessage
      const parts = method.split('.');
      let target: any = client ?? this.app.client;
      for (const part of parts) {
        target = target[part];
        if (!target) throw new Error(`Unknown Slack API method: ${method}`);
      }
      if (typeof target !== 'function') throw new Error(`${method} is not a function`);

      // Special case for filesUploadV2: read file from disk
      const resolvedArgs = { ...args };
      if (method === 'filesUploadV2' && typeof resolvedArgs.file_path === 'string') {
        const { readFileSync } = await import('node:fs');
        resolvedArgs.file = readFileSync(resolvedArgs.file_path as string);
        delete resolvedArgs.file_path;
      }

      const result = await target(resolvedArgs);
      return { result };
    });

    // Worker self-deregister (idle shutdown) — removes from registry so the
    // exit handler treats it as expected rather than a crash.
    // Must check PID to avoid a race: when a worker is killed and a replacement
    // spawned, the dying worker's SIGTERM handler sends this call, which would
    // otherwise remove the *new* worker's registry entry.
    // Register a callback ID so interactive actions can be routed to the correct worker
    this.server.registerMethod('slack.registerCallback', async (params) => {
      const { callbackId, threadKey } = params as { callbackId: string; threadKey: string };
      this.registry.registerCallback(callbackId, threadKey);
      return {};
    });

    this.server.registerMethod('worker.setState', async (params) => {
      const { threadKey, state, type } = params as { threadKey: string; state: string; type?: string };
      const sessionType = (type === 'lite' ? 'lite' : 'worker') as import('./session-registry.js').SessionType;
      this.registry.setState(threadKey, state as any, sessionType);
      return {};
    });

    this.server.registerMethod('worker.deregister', async (params) => {
      const { threadKey, pid } = params as { threadKey: string; pid?: number };
      const current = this.registry.get(threadKey);
      if (current && pid != null && current.pid !== pid) {
        this.logger.info('Ignoring stale worker.deregister (pid mismatch)', {
          threadKey, requestPid: pid, currentPid: current.pid,
        });
        return {};
      }
      this.logger.info('Worker self-deregistered (idle shutdown)', { threadKey });
      this.registry.remove(threadKey);
      return {};
    });
  }

  /** Resolve team ID via auth.test and cache it */
  async resolveTeamId(): Promise<string | undefined> {
    if (this.cachedTeamId) return this.cachedTeamId;
    await this.resolveAuthInfo();
    return this.cachedTeamId;
  }

  /** Resolve bot user ID via auth.test and cache it */
  async resolveBotUserId(): Promise<string | undefined> {
    if (this.cachedBotUserId) return this.cachedBotUserId;
    await this.resolveAuthInfo();
    return this.cachedBotUserId;
  }

  /** Shared auth.test call that caches both team ID and bot user ID */
  private async resolveAuthInfo(): Promise<void> {
    if (this.cachedTeamId && this.cachedBotUserId) return;
    try {
      const result = await this.app.client.auth.test();
      this.cachedTeamId = result.team_id;
      this.cachedBotUserId = result.user_id;
      this.logger.info('Resolved auth info', { teamId: this.cachedTeamId, botUserId: this.cachedBotUserId });
    } catch (err: any) {
      this.logger.warn('Failed to resolve auth info via auth.test', { error: err.message });
    }
  }

  /** Start the RPC server */
  async listen(): Promise<void> {
    await this.server.listen();
    this.logger.info('Gateway RPC server listening', { socketPath: GATEWAY_SOCKET });
  }

  /** Stop the RPC server */
  async close(): Promise<void> {
    await this.server.close();
    this.logger.info('Gateway RPC server closed');
  }
}

/**
 * Post an interactive prompt (permission, question, terminal) to Slack.
 * Extracted as a standalone function so it can be invoked from RPC handlers.
 */
export async function postInteractivePromptToSlack(
  app: App,
  threadKey: string,
  promptType: 'permission' | 'question' | 'terminal' | 'planReview',
  display: PromptDisplay,
  callbackId: string,
  logger: Logger,
): Promise<void> {
  const [channel, threadTs] = threadKey.split(':');
  try {
    if (promptType === 'permission') {
      // Batch permission: multiple tools in a single message
      if (display.tools && display.tools.length > 0) {
        const toolLines = display.tools.map((t: { tool: string; description: string }) =>
          `• \`${t.tool}\` — ${t.description}`
        ).join('\n');

        const buttons: any[] = [
          { type: 'button', text: { type: 'plain_text', text: `Allow All (${display.tools.length})` }, action_id: `${callbackId}_allow`, value: 'allow', style: 'primary' },
          { type: 'button', text: { type: 'plain_text', text: 'Deny All' }, action_id: `${callbackId}_deny`, value: 'deny', style: 'danger' },
        ];

        await app.client.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text: `Permission requested: ${display.tools.length} tools`,
          blocks: [
            {
              type: 'section',
              text: { type: 'mrkdwn', text: `*Permission requested:* ${display.tools.length} tools\n${toolLines}` },
            },
            { type: 'actions', elements: buttons },
          ],
        });
      } else {
        // Single permission request
        const buttons: any[] = [
          { type: 'button', text: { type: 'plain_text', text: 'Allow' }, action_id: `${callbackId}_allow`, value: 'allow', style: 'primary' },
        ];

        // Insert "Always" button between Allow and Deny when SDK provides suggestions
        if (display.alwaysAllowLabel) {
          buttons.push({
            type: 'button',
            text: { type: 'plain_text', text: 'Always' },
            action_id: `${callbackId}_always`,
            value: 'always',
          });
        }

        buttons.push(
          { type: 'button', text: { type: 'plain_text', text: 'Deny' }, action_id: `${callbackId}_deny`, value: 'deny', style: 'danger' },
        );

        const alwaysLine = display.alwaysAllowLabel ? `\nAlways pattern: \`${display.alwaysAllowLabel}\`` : '';
        // display.description is pre-formatted lockText (e.g. "`Bash` -> `cmd`")
        // Use it directly as mrkdwn; don't re-wrap in backticks.
        const description = display.description || '';
        const headerLine = description
          ? `*Permission requested:* ${description}`
          : `*Permission requested:* \`${display.tool}\``;

        await app.client.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text: `Permission requested: ${display.tool}${description ? ` — ${description}` : ''}`,
          blocks: [
            {
              type: 'section',
              text: { type: 'mrkdwn', text: `${headerLine}${alwaysLine}` },
            },
            { type: 'actions', elements: buttons },
          ],
        });
      }
    } else if (promptType === 'question') {
      const questions = display.questions as { header: string; question: string; options: { label: string; value: string; description?: string; preview?: string }[]; multiSelect?: boolean }[] | undefined;

      if (questions && questions.length > 0) {
        // Post only the first question (one at a time, not all in a single message)
        const q = questions[0];
        const blocks: any[] = [];

        blocks.push({
          type: 'section',
          text: { type: 'mrkdwn', text: `*${q.header}*\n${q.question}` },
        });

        // Radio buttons (or checkboxes if multiSelect) for options
        const slackOptions = q.options.map((opt) => {
          const option: any = {
            text: { type: 'plain_text', text: opt.label },
            value: `${callbackId}:0:${opt.value}`,
          };
          if (opt.description) {
            option.description = { type: 'plain_text', text: opt.description };
          }
          return option;
        });
        const elementType = q.multiSelect ? 'checkboxes' : 'radio_buttons';
        blocks.push({
          type: 'actions',
          elements: [
            {
              type: elementType,
              action_id: `${callbackId}_0`,
              options: slackOptions,
            },
          ],
        });

        // Option previews (code snippets, mockups) as markdown blocks
        const previews = q.options.filter((opt) => opt.preview);
        if (previews.length > 0) {
          blocks.push({ type: 'divider' });
          for (const opt of previews) {
            blocks.push({
              type: 'markdown',
              text: `**${opt.label}**\n${opt.preview}`,
            });
          }
        }

        // Text input for custom answers
        blocks.push({
          type: 'input',
          dispatch_action: true,
          block_id: `question_input_${callbackId}_0`,
          element: {
            type: 'plain_text_input',
            action_id: `${callbackId}_input_0`,
            placeholder: { type: 'plain_text', text: 'Or type your answer and press Enter\u2026' },
            dispatch_action_config: { trigger_actions_on: ['on_enter_pressed'] },
          },
          label: { type: 'plain_text', text: ' ' },
          optional: true,
        });

        await app.client.chat.postMessage({ channel, thread_ts: threadTs, text: 'Claude has a question for you', blocks });
      } else {
        // Fallback: simple title/options format
        const blocks: any[] = [];
        blocks.push({
          type: 'section',
          text: { type: 'mrkdwn', text: display.title || display.description || 'Question from Claude:' },
        });
        if (display.options && display.options.length > 0) {
          const radioOptions = display.options.map((opt: any) => ({
            text: { type: 'plain_text', text: opt.label },
            value: opt.value,
          }));
          blocks.push({
            type: 'actions',
            elements: [
              {
                type: 'radio_buttons',
                action_id: `${callbackId}_0`,
                options: radioOptions,
              },
            ],
          });
        }
        await app.client.chat.postMessage({ channel, thread_ts: threadTs, text: 'Claude has a question for you', blocks });
      }
    } else if (promptType === 'planReview') {
      if (display.planSplitMessages && display.planSplitMessages.length > 0) {
        for (const msgBlocks of display.planSplitMessages) {
          await app.client.chat.postMessage({
            channel,
            thread_ts: threadTs,
            text: 'Plan for review',
            blocks: msgBlocks as any[],
          });
        }
      } else if (display.planBlocks) {
        await app.client.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text: 'Plan for review',
          blocks: display.planBlocks as any[],
        });
      }
    } else if (promptType === 'terminal') {
      await app.client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: display.description || 'Terminal prompt — reply in thread to respond.',
      });
    }
  } catch (err: any) {
    logger.error('Failed to post interactive prompt', { error: err.message, callbackId });
  }
}
