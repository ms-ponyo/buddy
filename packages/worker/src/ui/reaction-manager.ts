// src/ui/reaction-manager.ts — Reaction management helpers.
// Ported from src/slack-handler/ui/reactions.ts.
// Stateless — takes an adapter-like object parameter and orchestrates add/remove calls.

/** Minimal interface for reaction operations (subset of SlackAdapter). */
export interface ReactionAdapter {
  addReaction(channel: string, ts: string, emoji: string): Promise<void>;
  removeReaction(channel: string, ts: string, emoji: string): Promise<void>;
}

/**
 * Remove one reaction and add another on each of the given message timestamps.
 * Errors are silently ignored (reaction may not exist, or may already be set).
 */
export async function setReactions(
  adapter: ReactionAdapter,
  channel: string,
  messageTimestamps: string[],
  add: string,
  remove: string,
): Promise<void> {
  for (const ts of messageTimestamps) {
    try {
      await adapter.removeReaction(channel, ts, remove);
    } catch {
      // Ignore — reaction may not exist
    }
    try {
      await adapter.addReaction(channel, ts, add);
    } catch {
      // Ignore — reaction may already exist
    }
  }
}

/**
 * Swap the hourglass_flowing_sand reaction for a new one on the given timestamps.
 */
export async function swapReactions(
  adapter: ReactionAdapter,
  channel: string,
  messageTimestamps: string[],
  newReaction: string,
): Promise<void> {
  await setReactions(adapter, channel, messageTimestamps, newReaction, 'hourglass_flowing_sand');
}

/**
 * Add the hourglass_flowing_sand reaction to a message.
 * Ignores errors if the reaction already exists.
 */
export async function addHourglass(
  adapter: ReactionAdapter,
  channel: string,
  messageTs: string,
): Promise<void> {
  try {
    await adapter.addReaction(channel, messageTs, 'hourglass_flowing_sand');
  } catch {
    // Ignore if reaction already exists
  }
}
