// src/util/text-helpers.ts — text manipulation utilities.
// Ported from src/slack-handler/util/text-helpers.ts. Pure functions, no external dependencies.

export function truncateStr(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '\u2026 (truncated)' : s;
}

/** Extract a short intent snippet from the LLM text that preceded a tool call. */
export function extractIntent(text: string): string {
  if (!text.trim()) return '';
  const lines = text.trim().split('\n').filter(l => l.trim());
  if (lines.length === 0) return '';
  // Strip leading markdown from each line and keep non-empty ones
  const cleaned = lines
    .map(l => l.replace(/^[#*\->\s]+/, '').trim())
    .filter(l => l);
  return cleaned.join('\n') || '';
}

/** Detect whether text looks like a plan or design document.
 *  Plans/designs have markdown headers (## or ###) and are typically 1000+ chars.
 *  Short explanations, transition text, and summaries don't match. */
export function looksLikePlan(text: string): boolean {
  if (text.length < 1000) return false;
  // Must have at least one markdown header
  return /^#{2,4}\s+\S/m.test(text);
}

/** Derive a concise plan title from user message and reasoning context. */
export function derivePlanTitle(userMessage: string, reasoningText: string): string {
  // PR review pattern
  const prMatch = userMessage.match(/(?:review|PR|pull request)\s*#?(\d+)/i);
  if (prMatch) return `Reviewing PR #${prMatch[1]}`;

  // Plan mode pattern
  if (/\bplan\b/i.test(userMessage)) {
    const topic = userMessage.replace(/.*\bplan\b\s*/i, '').trim();
    if (topic) return `Planning: ${topic.length > 60 ? topic.slice(0, 60) + '\u2026' : topic}`;
  }

  // Use first meaningful line of reasoning
  if (reasoningText.trim()) {
    const lines = reasoningText.trim().split('\n').filter(l => l.trim());
    if (lines.length > 0) {
      const cleaned = lines[0].replace(/^[#*\->\s]+/, '').trim();
      if (cleaned) return cleaned.length > 80 ? cleaned.slice(0, 80) + '\u2026' : cleaned;
    }
  }

  // Fallback: truncated user message
  const msg = userMessage.trim();
  return msg.length > 80 ? msg.slice(0, 80) + '\u2026' : msg;
}
