// Step-instruction injection via user-message decoration (keeps the cacheable
// system prefix byte-stable) + per-step tool filtering. Ported from
// ugly-studio f5a74c2^:server/coding-agent/patterns/decorate-user-message.ts.
import type { AgentToolSpec } from '../../../../shared/agent';
import type { Step } from './types';

const SEP = '\n\n---\n\n';

export function renderStepDecoration(step: Step): string {
  const askUser = step.askUserClause ? `\n\n${step.askUserClause}` : '';
  return `# Step: ${step.label}\n\n${step.systemPromptTail}${askUser}\n\nWhen this step is complete, end your turn — the orchestrator advances on its own.`;
}

export function decorateForStep(userText: string, step: Step): string {
  return `${userText}${SEP}${renderStepDecoration(step)}`;
}

/** Filter the model-facing tool specs to a step's allow-list (unset → all),
 *  appending any per-tool read-only description suffixes. */
export function filterToolsForStep(specs: AgentToolSpec[], step: Step | null): AgentToolSpec[] {
  if (!step?.allowedTools) return specs;
  const allow = new Set<string>(step.allowedTools);
  return specs
    .filter((s) => allow.has(s.name))
    .map((s) => {
      const suffix = step.toolDescriptionSuffixes?.[s.name];
      return suffix ? { ...s, description: `${s.description}${suffix}` } : s;
    });
}
