import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import { statSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, basename, join } from "node:path";
import type { SlackFileInfo, SlackMessage } from "../adapters/slack-adapter.js";

const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB
const FILES_DIR_BASE = resolve(process.cwd(), "data", "files");

interface SlackToolsServerParams {
  proxy: {
    conversationsReplies: (args: {
      channel: string; ts: string; limit?: number; cursor?: string;
      latest?: string; oldest?: string; inclusive?: boolean;
    }) => Promise<{ messages?: SlackMessage[]; response_metadata?: { next_cursor?: string } }>;
    conversationsHistory: (args: {
      channel: string; limit?: number; oldest?: string;
    }) => Promise<{ messages?: SlackMessage[] }>;
    filesInfo: (args: { file: string }) => Promise<{ file?: SlackFileInfo }>;
    uploadFile: (channel: string, threadTs: string, filename: string, filePath: string, caption?: string) => Promise<{ fileId: string }>;
    searchMessages?: (args: {
      query: string; sort?: string; sort_dir?: string; count?: number; page?: number;
    }) => Promise<{ messages?: { total: number; matches: any[] } }>;
  };
  token: string;
  channelId: string;
  threadTs: string;
  projectDir: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

export function createSlackToolsServer(params: SlackToolsServerParams) {
  const { proxy, token, channelId, threadTs, projectDir } = params;
  const filesDir = resolve(FILES_DIR_BASE, `${channelId}_${threadTs}`);

  return createSdkMcpServer({
    name: "slack-tools",
    tools: [
      tool(
        "upload_file_to_slack",
        "Upload a file from disk to the current Slack thread. Use after creating a file with Write/Bash that the user should see directly in Slack (images, CSVs, PDFs, generated artifacts, etc.).",
        {
          file_path: z.string().describe("Absolute path to the file on disk"),
          caption: z.string().optional().describe("Optional message to accompany the file"),
        },
        async (args) => {
          try {
            const filePath = resolve(args.file_path);

            if (!filePath.startsWith(resolve(projectDir))) {
              return textResult(`Error: File must be under project directory (${projectDir})`);
            }

            const stat = statSync(filePath);
            if (stat.size > MAX_FILE_BYTES) {
              return textResult(`Error: File is ${formatBytes(stat.size)}, exceeds ${formatBytes(MAX_FILE_BYTES)} limit`);
            }

            const filename = basename(filePath);
            const { fileId } = await proxy.uploadFile(channelId, threadTs, filename, filePath, args.caption);

            return textResult(`Uploaded ${filename} (${formatBytes(stat.size)}) to Slack thread [file_id: ${fileId}]`);
          } catch (err) {
            return textResult(`Upload failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        },
      ),
      tool(
        "download_slack_file",
        "Download a file from Slack to disk. Use when you need to read or process a file shared in the conversation.",
        {
          file_id: z.string().describe("Slack file ID from the file reference (e.g., F07ABC123)"),
          destination: z.string().optional().describe("Directory to save into. Defaults to session files directory."),
        },
        async (args) => {
          try {
            const dest = args.destination ? resolve(args.destination) : filesDir;
            const info = await proxy.filesInfo({ file: args.file_id });
            const file = info.file;
            const downloadUrl = file?.url_private_download ?? file?.url_private;

            if (!downloadUrl) {
              return textResult(`File ${args.file_id}: no download URL available`);
            }

            if (file?.size && file.size > MAX_FILE_BYTES) {
              return textResult(`File "${file.name}" (${file.size} bytes) exceeds ${formatBytes(MAX_FILE_BYTES)} limit`);
            }

            const resp = await fetch(downloadUrl, {
              headers: { Authorization: `Bearer ${token}` },
            });
            if (!resp.ok) {
              return textResult(`Download failed for ${args.file_id}: HTTP ${resp.status}`);
            }

            const buf = Buffer.from(await resp.arrayBuffer());
            const safeName = basename(file?.name ?? "file");
            mkdirSync(dest, { recursive: true });
            const filePath = join(dest, safeName);
            writeFileSync(filePath, buf);

            return textResult(`Downloaded ${safeName} to ${filePath} (${formatBytes(buf.length)})`);
          } catch (err) {
            return textResult(`Download failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        },
      ),
      tool(
        "fetch_thread_messages",
        "Fetch messages from a Slack thread. Returns the conversation history of a specific thread. Useful for reading context from other threads you're not currently in.",
        {
          channel: z.string().describe("Slack channel ID (e.g., C07ABC123)"),
          thread_ts: z.string().describe("Thread parent message timestamp (e.g., 1234567890.123456)"),
          limit: z.number().optional().describe("Max messages to return (default 50, max 200)"),
        },
        async (args) => {
          try {
            const limit = Math.min(args.limit ?? 50, 200);
            const messages: Array<{ user: string; text: string; ts: string; bot?: boolean }> = [];
            let cursor: string | undefined;

            do {
              const result = await proxy.conversationsReplies({
                channel: args.channel,
                ts: args.thread_ts,
                limit,
                ...(cursor ? { cursor } : {}),
              });
              for (const msg of result.messages ?? []) {
                messages.push({
                  user: msg.bot_id ? `bot:${msg.bot_id}` : (msg.user ?? "unknown"),
                  text: msg.text ?? "",
                  ts: msg.ts,
                  bot: !!msg.bot_id,
                });
                if (messages.length >= limit) break;
              }
              cursor = messages.length < limit ? result.response_metadata?.next_cursor : undefined;
            } while (cursor);

            if (messages.length === 0) {
              return textResult("No messages found in thread.");
            }

            const formatted = messages
              .map((m) => {
                const prefix = m.bot ? `[bot]` : `<@${m.user}>`;
                const time = new Date(Number(m.ts) * 1000).toISOString();
                return `${time} ${prefix}: ${m.text}`;
              })
              .join("\n\n");

            return textResult(`Thread messages (${messages.length}):\n\n${formatted}`);
          } catch (err) {
            return textResult(`Error fetching thread: ${err instanceof Error ? err.message : String(err)}`);
          }
        },
      ),
      tool(
        "fetch_channel_messages",
        "Fetch recent messages from a Slack channel. Returns the most recent messages in the channel (not inside threads). Useful for catching up on channel activity.",
        {
          channel: z.string().describe("Slack channel ID (e.g., C07ABC123)"),
          limit: z.number().optional().describe("Max messages to return (default 20, max 100)"),
          oldest: z.string().optional().describe("Only messages after this Unix timestamp (e.g., 1234567890.123456)"),
        },
        async (args) => {
          try {
            const limit = Math.min(args.limit ?? 20, 100);
            const result = await proxy.conversationsHistory({
              channel: args.channel,
              limit,
              ...(args.oldest ? { oldest: args.oldest } : {}),
            });

            const messages: Array<{ user: string; text: string; ts: string; bot?: boolean; thread_ts?: string; reply_count?: number }> = [];
            for (const msg of result.messages ?? []) {
              messages.push({
                user: msg.bot_id ? `bot:${msg.bot_id}` : (msg.user ?? "unknown"),
                text: msg.text ?? "",
                ts: msg.ts,
                bot: !!msg.bot_id,
                thread_ts: msg.thread_ts,
                reply_count: msg.reply_count,
              });
            }

            if (messages.length === 0) {
              return textResult("No messages found in channel.");
            }

            const formatted = messages
              .map((m) => {
                const prefix = m.bot ? `[bot]` : `<@${m.user}>`;
                const time = new Date(Number(m.ts) * 1000).toISOString();
                const threadInfo = m.reply_count ? ` [${m.reply_count} replies, thread_ts: ${m.thread_ts}]` : "";
                return `${time} ${prefix}: ${m.text}${threadInfo}`;
              })
              .join("\n\n");

            return textResult(`Channel messages (${messages.length}):\n\n${formatted}`);
          } catch (err) {
            return textResult(`Error fetching channel: ${err instanceof Error ? err.message : String(err)}`);
          }
        },
      ),
      tool(
        "fetch_message",
        "Fetch a single Slack message by its timestamp. Useful for reading the full content of a specific message (e.g., a long reply that was truncated in thread history). For very long messages, set save_to_file=true to write content to a file instead of returning inline.",
        {
          channel: z.string().describe("Slack channel ID (e.g., C07ABC123)"),
          ts: z.string().describe("Message timestamp (e.g., 1234567890.123456)"),
          thread_ts: z.string().optional().describe("Parent thread timestamp, if the message is a thread reply"),
          save_to_file: z.boolean().optional().describe("Save to file instead of returning inline. Auto-enabled for messages over 10K chars."),
        },
        async (args) => {
          try {
            const result = await proxy.conversationsReplies({
              channel: args.channel,
              ts: args.thread_ts ?? args.ts,
              latest: args.ts,
              oldest: args.ts,
              inclusive: true,
              limit: 1,
            });
            const msg = (result.messages ?? []).find((m) => m.ts === args.ts);
            if (!msg) {
              return textResult("Message not found.");
            }
            const prefix = msg.bot_id ? "[bot]" : `<@${msg.user ?? "unknown"}>`;
            const time = new Date(Number(msg.ts) * 1000).toISOString();
            const text = msg.text ?? "(no text)";
            const content = `${time} ${prefix}:\n\n${text}`;

            const shouldSave = args.save_to_file ?? content.length > 10_000;
            if (shouldSave) {
              const dir = join(process.cwd(), "data", "slack-messages");
              mkdirSync(dir, { recursive: true });
              const filePath = join(dir, `${args.channel}_${args.ts}.txt`);
              writeFileSync(filePath, content);
              return textResult(`Message (${formatBytes(content.length)}) saved to: ${filePath}\nUse the Read tool to view it.`);
            }

            return textResult(content);
          } catch (err) {
            return textResult(`Error fetching message: ${err instanceof Error ? err.message : String(err)}`);
          }
        },
      ),
      ...(proxy.searchMessages ? [tool(
        "search_messages",
        "Search for messages across Slack channels. Supports Slack search modifiers like 'from:@user', 'in:#channel', 'before:2026-01-01', 'after:2026-01-01', 'has:link', etc. Requires a user token (SLACK_USER_TOKEN) to be configured.",
        {
          query: z.string().describe("Search query string. Supports Slack search operators: from:, in:, before:, after:, has:, etc."),
          sort: z.enum(["score", "timestamp"]).optional().describe("Sort by relevance (score) or recency (timestamp). Default: score"),
          sort_dir: z.enum(["asc", "desc"]).optional().describe("Sort direction. Default: desc"),
          count: z.number().optional().describe("Number of results per page (default 20, max 100)"),
          page: z.number().optional().describe("Page number for pagination (default 1)"),
        },
        async (args) => {
          try {
            const result = await proxy.searchMessages!(args);
            const matches = result.messages?.matches ?? [];
            const total = result.messages?.total ?? 0;

            if (matches.length === 0) {
              return textResult("No messages found.");
            }

            const formatted = matches
              .map((m: any) => {
                const time = m.ts ? new Date(Number(m.ts) * 1000).toISOString() : "unknown";
                const user = m.username || m.user || "unknown";
                const channel = m.channel?.name ? `#${m.channel.name}` : (m.channel?.id ?? "unknown");
                const permalink = m.permalink ?? "";
                return `${time} @${user} in ${channel}:\n${m.text}\n${permalink}`;
              })
              .join("\n---\n");

            return textResult(`Found ${total} messages (showing ${matches.length}):\n\n${formatted}`);
          } catch (err) {
            return textResult(`Search failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        },
      )] : []),
    ],
  });
}
