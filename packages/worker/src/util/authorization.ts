// src/util/authorization.ts — channel/user authorization check.
// Ported from src/slack-handler/util/authorization.ts.
// Uses BuddyConfig from types instead of the old Config type.

import type { BuddyConfig } from '../types.js';

export function isAuthorized(
  userId: string,
  channelId: string,
  channelType: string | undefined,
  config: Pick<BuddyConfig, 'adminUserIds' | 'allowedUserIds' | 'allowedChannelIds'>,
): boolean {
  // Admins always pass
  if (config.adminUserIds.length > 0 && config.adminUserIds.includes(userId)) {
    return true;
  }
  // User allowlist check (empty = no restriction)
  if (config.allowedUserIds.length > 0 && !config.allowedUserIds.includes(userId)) {
    return false;
  }
  // DMs: only user allowlist applies (already passed above)
  if (channelType === "im") {
    return true;
  }
  // Channels: channel allowlist must also pass (empty = no restriction)
  if (config.allowedChannelIds.length > 0 && !config.allowedChannelIds.includes(channelId)) {
    return false;
  }
  return true;
}
