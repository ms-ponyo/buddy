// Gateway authorization — rejects unauthorized users before routing or spawning workers.

export interface AuthConfig {
  adminUserIds: string[];
  allowedUserIds: string[];
  allowedChannelIds: string[];
}

export function isAuthorized(
  userId: string,
  channelId: string,
  channelType: string | undefined,
  config: AuthConfig,
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
  if (channelType === 'im') {
    return true;
  }
  // Channels: channel allowlist must also pass (empty = no restriction)
  if (config.allowedChannelIds.length > 0 && !config.allowedChannelIds.includes(channelId)) {
    return false;
  }
  return true;
}

export function parseCommaSeparated(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(',').map(s => s.trim()).filter(Boolean);
}
