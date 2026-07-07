// `ask_user` — surface a genuine fork to the user. In ugly-code the agent chat
// IS the interface, so this ends the turn with the question; the user answers in
// their next message. Ported (simplified) from ugly-studio f5a74c2^:.../ask_user.ts.

import type { TextGenTool } from 'ugly-app/shared';
import type { ToolModule } from './registry';

const SPEC: TextGenTool = {
  name: 'ask_user',
  description:
    'Ask the user a question when you hit a GENUINE fork you cannot resolve ' +
    '(their intent, a real tiebreak). Not for scope/preference you can decide. ' +
    'This ends your turn; the user answers in their next message.',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question to ask.' },
      options: { type: 'array', items: { type: 'string' }, description: 'Optional choices to offer.' },
    },
    required: ['question'],
    additionalProperties: false,
  },
};

export const askUserTool: ToolModule = {
  name: 'ask_user',
  spec: SPEC,
  // eslint-disable-next-line @typescript-eslint/require-await
  async run(input) {
    const question = (typeof input.question === 'string' ? input.question : '').trim();
    if (!question) return 'ask_user: `question` is required';
    const options = Array.isArray(input.options)
      ? (input.options as unknown[]).map((o) => String(o))
      : [];
    const opts = options.length ? `\nOptions: ${options.join(' | ')}` : '';
    return `[Awaiting your answer]\n${question}${opts}`;
  },
};
