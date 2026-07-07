/**
 * Minimal ask_user broker (task side) — ported from the monolith's
 * server/coding-agent/ask-user/broker.ts. Owns the pending resolvers for
 * in-flight `ask_user` tool calls; `answerPendingAskUser` resolves one when the
 * IDE posts the user's answer back through `codingAgentAnswerAskUser`.
 *
 * The `ask_user` TOOL is not registered in this Phase-1 tree yet: the chat renders
 * ask-user cards from `session_state` snapshots (pendingAskUsers), which the
 * task-based agent loop does not emit. This broker is the ready answer-side
 * plumbing so wiring the tool + snapshot emission is a localized follow-up.
 */

const pending = new Map<string, (answer: string) => void>();

/** Register a pending ask_user call and await the user's answer. */
export function awaitAskUser(toolCallId: string): Promise<string> {
  return new Promise<string>((resolve) => {
    pending.set(toolCallId, resolve);
  });
}

/** Resolve a pending ask_user call. Returns false when the id is unknown. */
export function answerPendingAskUser(toolCallId: string, answer: string): boolean {
  const resolve = pending.get(toolCallId);
  if (!resolve) return false;
  pending.delete(toolCallId);
  resolve(answer);
  return true;
}

/** Kick every pending call (session abort) so awaiting turns exit cleanly. */
export function rejectAllAskUser(): void {
  for (const [id, resolve] of pending) {
    resolve('[ask_user cancelled]');
    pending.delete(id);
  }
}
