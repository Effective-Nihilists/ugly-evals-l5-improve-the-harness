/**
 * Studio chat display transforms — the single source of truth for turning agent
 * content into the studio's `parts` shape. Used by BOTH the live emit
 * (clientAgent.ts) and history replay (codingAgentChatListMessages in useSocket),
 * so a replayed session renders byte-identically to one streamed live.
 *
 * Lives in its own module (no useSocket import) to avoid a static import cycle.
 */

import type { ContentPart } from 'ugly-app/agent/client';
import { decodeAssistantPayload, type StoredMessageRow, type ToolRowPayload } from './serverSessionApi';

export interface Part {
  type: 'text' | 'tool_call' | 'tool_result' | 'finish';
  data?: Record<string, unknown>;
}

/** Build the studio `parts` array for an assistant turn from its content. */
export function assistantParts(content: ContentPart[]): Part[] {
  const parts: Part[] = [];
  for (const blk of content) {
    if (blk.type === 'text' && blk.text) {
      parts.push({ type: 'text', data: { text: blk.text } });
    } else if (blk.type === 'tool_use') {
      parts.push({
        type: 'tool_call',
        // The studio renders tool_call.input as a JSON string, not an object.
        data: {
          id: blk.id,
          name: blk.name,
          input: typeof blk.input === 'string' ? blk.input : JSON.stringify(blk.input ?? {}),
          finished: true,
        },
      });
    }
  }
  parts.push({ type: 'finish' });
  return parts;
}

export interface DisplayMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  parts: Part[];
  /** The model that produced an assistant message (drives the model badge). */
  model?: string;
}

/**
 * Map stored transcript rows → studio display messages for history replay.
 * A tool row expands to one message per result (matching the live per-result
 * emit); a compaction `summary` row renders as an inline marker at its timeline
 * position. The content JSON is parsed per role/kind (see clientAgent persist).
 */
export function rowsToDisplayMessages(sessionId: string, rows: StoredMessageRow[]): DisplayMessage[] {
  const out: DisplayMessage[] = [];
  for (const r of rows) {
    const baseId = `${sessionId}:${r.kind === 'summary' ? 'summary:' : ''}${r.seq}`;
    let payload: unknown;
    try {
      payload = JSON.parse(r.content);
    } catch {
      payload = r.content;
    }
    if (r.kind === 'summary') {
      out.push({
        id: baseId,
        role: 'assistant',
        parts: [
          { type: 'text', data: { text: `↻ Compacted earlier messages to stay within the context window.\n\n${String(payload)}` } },
          { type: 'finish' },
        ],
      });
    } else if (r.role === 'assistant') {
      const { content, model } = decodeAssistantPayload(payload);
      out.push({ id: baseId, role: 'assistant', parts: assistantParts(content), ...(model ? { model } : {}) });
    } else if (r.role === 'tool') {
      const results = (payload as Partial<ToolRowPayload>).results ?? [];
      results.forEach((x, i) => {
        out.push({
          id: `${baseId}:${i}`,
          role: 'tool',
          parts: [{ type: 'tool_result', data: { tool_call_id: x.tool_use_id, content: x.content, is_error: x.is_error } }],
        });
      });
    } else {
      out.push({ id: baseId, role: 'user', parts: [{ type: 'text', data: { text: String(payload) } }] });
    }
  }
  return out;
}
