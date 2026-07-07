// The standalone `codebase_readiness` event updates ONLY the chat header's codebase pill.
// It exists so the pill fills in the moment the session task boots (the host's indexer +
// architecture poll starts at boot, not on the first turn) WITHOUT re-emitting a full
// `session_state` snapshot — a boot-time snapshot carries zeroed telemetry that would clobber
// a resumed session's live cost/token header while indexing runs. See `ensureCodebaseAnalysis`
// (clientAgent) for the producer and the `codebase_readiness` branch in useCodingAgentChat for
// the consumer.
import { CodebaseReadinessSchema, type SessionSnapshot } from '../shared/api';

/**
 * Validate a `codebase_readiness` event's payload into a readiness object.
 * The wire frame is `{ payload: { payload: <readiness> } }` (same double-wrap the other
 * coding-agent events use). Returns null on a malformed/older-host payload — best-effort UI,
 * never throws.
 */
export function parseCodebaseReadinessEvent(
  payload: unknown,
): SessionSnapshot['codebaseReadiness'] | null {
  const raw = (payload as { payload?: unknown } | undefined)?.payload;
  const parsed = CodebaseReadinessSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
