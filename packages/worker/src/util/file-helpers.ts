// src/util/file-helpers.ts — Slack file extraction and hint formatting.
// Ported from src/slack-handler/util/file-helpers.ts. Pure functions, no external dependencies.

import type { SlackFile, FileAttachment } from '../types.js';

export function extractFiles(event: Record<string, unknown>): SlackFile[] {
  const files = event.files as Array<Record<string, unknown>> | undefined;
  if (!files) return [];
  return files
    .filter((f) => (f.id as string | undefined))
    .map((f) => ({
      id: (f.id as string) ?? "",
      url: (f.url_private as string) ?? "",
      name: (f.name as string) ?? "file",
      size: (f.size as number) ?? 0,
    }));
}

/**
 * Build file hint strings from either SlackFile[] (URL-based, pre-download) or
 * FileAttachment[] (content already downloaded). Both carry a `name` property.
 */
export function buildFileHints(files: (SlackFile | FileAttachment)[]): string {
  if (files.length === 0) return "";
  return files
    .map((f) => {
      if ('id' in f && 'url' in f) {
        // SlackFile — user hasn't downloaded yet, hint to use tool
        const size = f.size > 0 ? `, ${(f.size / 1024).toFixed(0)} KB` : "";
        return `[Slack file: ${f.name} (id: ${f.id}${size}) \u2014 use download_slack_file tool to access]`;
      }
      // FileAttachment — content is already available inline
      const attach = f as FileAttachment;
      return `[Attached file: ${attach.name} (${attach.mimetype})]`;
    })
    .join("\n");
}
