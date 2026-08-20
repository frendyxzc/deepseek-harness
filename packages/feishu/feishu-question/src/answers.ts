/**
 * Option-answer parsing for `@deepseek-ai/dsh-feishu-question`: a pure
 * function from the attacker-controllable button `value` of a card-action
 * event to the wire-safe answer record of `@deepseek-ai/dsh-user-questions`.
 * The selected option index is echoed back from the button's own `value`, so
 * a forged or foreign index parses to nothing rather than to a wrong answer.
 *
 * @module @deepseek-ai/dsh-feishu-question/answers
 */

import type { AskUserQuestionAnswerItem, AskUserQuestionItem, AskUserQuestionOption } from '@deepseek-ai/dsh-user-questions'

/**
 * Map a tapped option index to one question's answer record. A malformed or
 * out-of-range index answers nothing.
 * @param question - the question the tapped button belonged to.
 * @param sel - the tapped button's `sel` value, a decimal option index.
 * @returns the answer record, or `undefined` when `sel` selects no option.
 */
export function parseOptionAnswer(question: AskUserQuestionItem, sel: unknown): AskUserQuestionAnswerItem | undefined {
  const options = question.options ?? []
  const index = typeof sel === 'string' ? Number(sel) : NaN
  if (!Number.isInteger(index) || index < 0 || index >= options.length) return undefined
  const option = options[index] as AskUserQuestionOption | undefined
  return option === undefined ? undefined : { id: question.id, selected: [option.label] }
}
