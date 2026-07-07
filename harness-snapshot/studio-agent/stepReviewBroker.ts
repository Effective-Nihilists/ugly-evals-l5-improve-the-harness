/**
 * Step-review broker (task side) — the resume half of the pattern engine's
 * `pauseForUserReviewAfter` gate. Ported in spirit from the monolith's
 * step-review handshake. The driver parks after a SPEC / DIAGNOSE step by
 * calling `awaitStepReview(id, sessionId)`; the IDE renders the pending card
 * from the `session_state` snapshot (pendingStepReviews) and posts the user's
 * approve/iterate reply back through `codingAgentAnswerStepReview`, which the
 * task's `answerStepReview` handler routes to `answerPendingStepReview`.
 */

export interface StepReviewReply {
  action: 'continue' | 'iterate';
  feedback?: string;
}

interface PendingEntry {
  sessionId: string;
  resolve: (reply: StepReviewReply) => void;
}

const pending = new Map<string, PendingEntry>();

/** Register a parked step-review gate and await the user's approve/iterate reply. */
export function awaitStepReview(id: string, sessionId: string): Promise<StepReviewReply> {
  return new Promise<StepReviewReply>((resolve) => {
    pending.set(id, { sessionId, resolve });
  });
}

/** Resolve a parked step review. Returns an outcome tag for the answer RPC. */
export function answerPendingStepReview(
  id: string,
  action: 'continue' | 'iterate',
  feedback?: string,
): 'ok' | 'already_answered' {
  const entry = pending.get(id);
  if (!entry) return 'already_answered';
  pending.delete(id);
  entry.resolve({ action, ...(feedback ? { feedback } : {}) });
  return 'ok';
}

/** Release every parked review for a session (abort / clear) so the driver exits. */
export function rejectStepReviewsForSession(sessionId: string): void {
  for (const [id, entry] of pending) {
    if (entry.sessionId !== sessionId) continue;
    pending.delete(id);
    entry.resolve({ action: 'continue' }); // unblock; the abort tears the turn down anyway
  }
}
