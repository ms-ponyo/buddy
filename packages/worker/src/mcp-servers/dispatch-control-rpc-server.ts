// src/mcp-servers/dispatch-control-rpc-server.ts — Dispatch-control MCP server
// backed by RPC instead of shared in-memory objects.
//
// Used by the lite worker (separate process) to control the main worker over IPC.
// The tool names, descriptions, and schemas are identical to dispatch-control-server.ts
// so the LLM sees no difference.

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";

// ── RPC client interface ───────────────────────────────────────────
//
// Matches the interface defined in services/remote-config-overrides.ts.
// Kept local so this module has no runtime dependency on that file.

export interface RpcClient {
  call(method: string, params?: unknown): Promise<unknown>;
}

// ── Helpers ───────────────────────────────────────────────────────

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── Exported handler functions (for testability) ──────────────────

export async function handleStopExecution(rpcClient: RpcClient): Promise<string> {
  try {
    await rpcClient.call("worker.interrupt");
    return "Execution stopped successfully.";
  } catch (err) {
    return `Main worker is not reachable: ${errMsg(err)}`;
  }
}

export async function handleSendToBackground(rpcClient: RpcClient): Promise<string> {
  try {
    await rpcClient.call("worker.sendToBackground");
    return "Execution sent to background.";
  } catch (err) {
    return `Main worker is not reachable: ${errMsg(err)}`;
  }
}

export async function handleSwitchPermissionMode(
  rpcClient: RpcClient,
  args: { mode: string },
): Promise<string> {
  try {
    await rpcClient.call("worker.switchMode", { mode: args.mode });

    const labels: Record<string, string> = {
      default: "Default",
      acceptEdits: "Accept Edits",
      bypassPermissions: "Bypass Permissions",
      dontAsk: "Don't Ask",
      plan: "Plan Only",
      auto: "Auto",
    };

    const label = labels[args.mode] ?? args.mode;
    return `Permission mode switched to: ${label}`;
  } catch (err) {
    return `Main worker is not reachable: ${errMsg(err)}`;
  }
}

export async function handleSwitchModel(
  rpcClient: RpcClient,
  args: { model: string },
): Promise<string> {
  try {
    await rpcClient.call("worker.switchModel", { model: args.model });
    return `Model switched to: ${args.model}`;
  } catch (err) {
    return `Main worker is not reachable: ${errMsg(err)}`;
  }
}

export async function handleGetStatus(rpcClient: RpcClient): Promise<string> {
  try {
    const raw = await rpcClient.call("worker.getStatus") as Record<string, unknown>;
    return JSON.stringify(raw, null, 2);
  } catch (err) {
    return `Main worker is not reachable: ${errMsg(err)}`;
  }
}

export async function handleSwitchMode(
  rpcClient: RpcClient,
  args: { mode: string },
): Promise<string> {
  return handleSwitchPermissionMode(rpcClient, args);
}

// ── MCP server factory ────────────────────────────────────────────

/**
 * Creates a dispatch-control MCP server that delegates every tool call
 * to the main worker via RPC.  Drop-in replacement for
 * createDispatchControlServer from the LLM's perspective.
 */
export function createDispatchControlRpcServer(rpcClient: RpcClient) {
  return createSdkMcpServer({
    name: "dispatch-control",
    tools: [
      // ── 1. stop_execution ─────────────────────────────────────────
      tool(
        "stop_execution",
        "Stop the main execution for this thread. Sets the execution as interrupted, closes the input queue, and terminates the active SDK session.",
        {},
        async () => {
          const text = await handleStopExecution(rpcClient);
          return textResult(text);
        },
      ),

      // ── 2. send_to_background ─────────────────────────────────────
      tool(
        "send_to_background",
        "Send the main execution to the background. The execution will continue running but status updates will be suppressed in the Slack thread.",
        {},
        async () => {
          const text = await handleSendToBackground(rpcClient);
          return textResult(text);
        },
      ),

      // ── 3. switch_permission_mode ─────────────────────────────────
      tool(
        "switch_permission_mode",
        "Switch the permission mode for the current thread. 'default' requires approval for risky operations, 'acceptEdits' auto-approves file edits, 'plan' requires approval for all changes.",
        {
          mode: z.enum(["default", "acceptEdits", "plan"]).describe(
            "The permission mode to switch to",
          ),
        },
        async (args) => {
          const text = await handleSwitchPermissionMode(rpcClient, args);
          return textResult(text);
        },
      ),

      // ── 4. switch_model ───────────────────────────────────────────
      tool(
        "switch_model",
        "Switch the AI model used for the current thread. The new model will be used for subsequent API calls in this thread.",
        {
          model: z.string().describe(
            "The model identifier to switch to (e.g. 'claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5-20251001')",
          ),
        },
        async (args) => {
          const text = await handleSwitchModel(rpcClient, args);
          return textResult(text);
        },
      ),

      // ── 5. get_status ─────────────────────────────────────────────
      tool(
        "get_status",
        "Get the current execution status for this thread, including model, permission mode, cost, session info, and whether it is running or backgrounded.",
        {},
        async () => {
          const text = await handleGetStatus(rpcClient);
          return textResult(text);
        },
      ),

      // ── 6. fork_thread ────────────────────────────────────────────
      tool(
        "fork_thread",
        "Fork the current thread into a new independent thread in the same channel. "
        + "Creates a new channel message that starts a new worker session with full conversation context from this thread. "
        + "Use when the user wants to start a parallel task while preserving context from the current conversation.",
        {
          prompt: z.string().optional().describe(
            "Optional task prompt for the new thread. If omitted, the new thread waits for user input."
          ),
        },
        async (args) => {
          try {
            const raw = await rpcClient.call("worker.forkThread", {
              prompt: args.prompt ?? null,
            }) as Record<string, unknown>;
            const permalink = raw?.permalink as string | null | undefined;
            if (permalink) {
              return textResult(`Forked to new thread: ${permalink}`);
            }
            return textResult("Forked to new thread.");
          } catch (err) {
            return textResult(`Main worker is not reachable: ${errMsg(err)}`);
          }
        },
      ),

      // ── 7. execute_bot_command ────────────────────────────────────
      tool(
        "execute_bot_command",
        "Execute a bot command directly. Use this instead of telling the user to type the command. "
        + "Bot commands: model, mode, effort, budget, clear, status, help, interrupt, stop, cost, usage, compact, bg, version, doctor, agents, fallback, agent, system, tools, worktree, pr, log. "
        + "SDK slash commands (forwarded to main worker): context, review, config, permissions, mcp, listen, vim, diff, init-worktree, login, logout.",
        {
          command: z.string().describe(
            "The bot command name (e.g. 'clear', 'cost', 'model', 'effort', 'budget', 'status')"
          ),
          args: z.string().optional().describe(
            "Optional arguments (e.g. model name for model, 'high' for effort, '5.00' for budget)"
          ),
        },
        async (params) => {
          try {
            const raw = await rpcClient.call("worker.executeBotCommand", {
              command: params.command.toLowerCase().trim(),
              args: params.args?.trim() ?? "",
            }) as Record<string, unknown> | null | undefined;
            const cmd = params.command.toLowerCase().trim();
            if (raw?.type === "dispatch") {
              return textResult(`Command '${cmd}' dispatched: ${raw.reply ?? ""}`);
            }
            return textResult(
              `Command '${cmd}' executed successfully.${raw?.reply ? ` ${raw.reply}` : ""}`,
            );
          } catch (err) {
            return textResult(`Main worker is not reachable: ${errMsg(err)}`);
          }
        },
      ),
    ],
  });
}
