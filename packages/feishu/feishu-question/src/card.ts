/**
 * Question-card builders for `@deepseek-ai/dsh-feishu-question`: pure
 * functions from the asked questions and a minted nonce to Feishu
 * interactive-card JSON in the v1 card schema the Bot API renders. Every
 * option is a button whose `value` carries the nonce, the question id, and
 * the selected option index, so one tap settles exactly one question of the
 * ask; the nonce is the only correlation token between a tap and the ask it
 * settles. A question without options renders a note inviting a chat reply,
 * because the v1 schema has no free-text control.
 *
 * @module @deepseek-ai/dsh-feishu-question/card
 */

import type { AskUserQuestionAnswerItem, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'

/** Detail text is capped before it is embedded in card markup. */
const MAX_DETAIL_CHARS = 8000

/** Cap the rendered detail before embedding it in card markup. */
function truncateDetail(detail: string): string {
  return detail.length > MAX_DETAIL_CHARS ? `${detail.slice(0, MAX_DETAIL_CHARS)}…` : detail
}

/** Heading markdown for one question, bolding a non-empty header when present. */
function questionHeading(question: AskUserQuestionItem): string {
  return question.header !== undefined && question.header.length > 0
    ? `**${question.header}** ${question.question}`
    : question.question
}

/** The question plus its option-list markdown, with one bullet per option. */
function optionListMarkdown(question: AskUserQuestionItem): string {
  const lines = (question.options ?? []).map(option =>
    option.description !== undefined && option.description.length > 0
      ? `• **${option.label}** — ${option.description}`
      : `• **${option.label}**`)
  return lines.length > 0 ? `${questionHeading(question)}\n${lines.join('\n')}` : questionHeading(question)
}

/**
 * Build the interactive question card for one ask in the v1 schema: the
 * batch detail (a plan-review renders the plan itself), one button per option
 * for every question, and a note inviting a chat reply for optionless
 * questions. Pure function of the questions and the minted nonce.
 * @param questions - the questions the card asks.
 * @param nonce - the one-time nonce binding the card to its pending ask.
 * @returns the Feishu interactive-card object.
 */
export function questionCard(questions: AskUserQuestionItem[], nonce: string): Record<string, unknown> {
  const isPlanReview = questions.some(question => question.intent?.kind === 'plan-review')
  const detail = questions.find(question => question.detail !== undefined)?.detail
  const elements: Array<Record<string, unknown>> = []
  if (detail !== undefined) {
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: truncateDetail(detail) } })
  }
  for (const question of questions) {
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: optionListMarkdown(question) } })
    const options = question.options ?? []
    if (options.length > 0) {
      elements.push({
        tag: 'action',
        actions: options.map((option, offset) => ({
          tag: 'button',
          text: { tag: 'plain_text', content: option.label },
          type: offset === 0 ? 'primary' : 'default',
          value: { nonce, pq: nonce, qid: question.id, sel: String(offset) },
        })),
      })
    } else {
      elements.push({
        tag: 'note',
        elements: [{ tag: 'plain_text', content: '→ 此问题无选项，请直接在聊天里输入文字回答。' }],
      })
    }
  }
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: isPlanReview ? 'Plan review' : 'The agent has a question' },
      template: isPlanReview ? 'orange' : 'blue',
    },
    elements,
  }
}

/**
 * Build the settled summary card that replaces a question card once an
 * answer is in: each question followed by the answer the user gave. Pure
 * function of the questions and their answers.
 * @param questions - the questions the card asked, in display order.
 * @param answers - the answers keyed by question id.
 * @returns the Feishu interactive-card JSON string ready for `updateMessage`.
 */
export function answerSummaryCard(questions: AskUserQuestionItem[], answers: AskUserQuestionAnswerItem[]): string {
  const byId = new Map(answers.map(answer => [answer.id, answer]))
  const lines = questions.map((question) => {
    const answer = byId.get(question.id)
    const given = answer === undefined
      ? '(no answer)'
      : answer.custom !== undefined && answer.custom.length > 0
        ? answer.custom
        : answer.selected.length > 0 ? answer.selected.join(', ') : '(no answer)'
    return `**${question.question}**\n${given}`
  })
  return noteCard(`✅ Answered\n${lines.join('\n')}`)
}

/**
 * Build a short note card for a settlement that produced no answer — a
 * timeout, an abort, a supersede, or a channel teardown.
 * @param note - the user-facing outcome line.
 * @returns the Feishu interactive-card JSON string ready for `updateMessage`.
 */
export function noteCard(note: string): string {
  return JSON.stringify({
    config: { wide_screen_mode: true },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: note } },
    ],
  })
}
