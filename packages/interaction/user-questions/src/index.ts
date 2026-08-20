/**
 * Service Definition for the user-questions capability seam (`ctx.userQuestions`): a UI-backed service for
 * pausing an agent tool call until the human answers a question. The model-
 * facing tool lives in `@deepseek-ai/dsh-tool-ask-user`; UI packages provide
 * routed providers (opting into asks via `accepts`) and one default provider,
 * and `ask()` races every willing provider for the first human answer.
 *
 * @module @deepseek-ai/dsh-user-questions
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { HarnessError } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/cordis' {
  interface Context {
    userQuestions: UserQuestionService
  }
}

import type { AskUserQuestionAnswer, AskUserQuestionItem } from './types.ts'

export type {
  AskUserQuestionAnswer, AskUserQuestionAnswerItem, AskUserQuestionIntent, AskUserQuestionItem,
  AskUserQuestionOption,
} from './types.ts'

/** Request for a human answer. */
export interface AskUserQuestionRequest {
  /** Questions to display. */
  questions: AskUserQuestionItem[]
  /** Exact live calling agent, when the request came from an agent tool call. */
  agent?: Agent
  /** Abort signal for the owning tool/step. */
  signal?: AbortSignal
}

/** UI-side provider for user questions. */
export interface UserQuestionProvider {
  ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer>
  /**
   * Optional participation predicate for routed asks. Declaring it makes this
   * provider a routed answerer: `ask()` offers a request to every routed
   * answerer whose predicate accepts it and to the default provider, and the
   * first answer wins. Providers without a predicate compete for the single
   * default slot.
   *
   * @param request - The ask whose owner, binding, and questions decide participation.
   * @returns Whether this provider takes part in answering the request.
   */
  accepts?(request: AskUserQuestionRequest): boolean
}

/** Stable error taxonomy for user-questions failures. */
export class UserQuestionError extends HarnessError {
  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'UserQuestionError'
  }
}

/** `ctx.userQuestions`: routed answerers, one default provider, and a first-answer-wins `ask()` API. */
export class UserQuestionService extends Service {
  private provider: UserQuestionProvider | undefined
  private readonly routers: UserQuestionProvider[] = []

  constructor(ctx: Context) {
    super(ctx, 'userQuestions')
  }

  /**
   * Register a UI provider. A provider declaring `accepts` is a routed
   * answerer and may coexist with other routed answerers; a provider without
   * one is the default fallback, of which only one may be active in a context.
   *
   * @param provider UI-side implementation that collects answers.
   * @returns Disposer that unregisters this provider.
   */
  registerProvider(provider: UserQuestionProvider): () => void {
    const dispose = this.ctx.effect(function* (this: UserQuestionService) {
      if (provider.accepts !== undefined) {
        this.routers.push(provider)
        yield () => {
          const index = this.routers.indexOf(provider)
          /* v8 ignore next -- defensive: dispose runs once per registration,
             so the provider is always still in the list here */
          if (index >= 0) this.routers.splice(index, 1)
        }
        return
      }
      if (this.provider !== undefined) {
        throw new UserQuestionError('a default user-questions provider is already registered', 'DUPLICATE_PROVIDER')
      }
      this.provider = provider
      yield () => {
        this.provider = undefined
      }
    }.bind(this), 'userInteraction.registerProvider()')
    return () => void dispose()
  }

  /**
   * Ask the user and wait for the answer. Every routed answerer whose
   * `accepts` claims the request and the default provider are offered the
   * request together; the first human answer wins, and the remaining offers
   * are withdrawn through a derived abort signal.
   *
   * When a caller supplies an agent, human interaction is valid only for the
   * exact live runtime root. Runtime ownership, not durable session lineage,
   * decides this boundary: an owned child has no human answerer and would
   * block forever, while a lineage-bearing session resumed as a new runtime
   * root may ask normally.
   *
   * @param request Questions, owner agent, and abort signal.
   * @returns The answer chosen or typed by the human.
   * @throws {UserQuestionError} code `NO_PROVIDER` when no routed answerer
   *   accepts the request and no default provider is registered.
   * @throws {UserQuestionError} code `CALLER_NOT_LIVE` when a supplied
   *   agent is not the registry's exact live instance, or `DELEGATED_CALLER`
   *   when that live agent is owned by another agent.
   */
  async ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> {
    if (request.signal?.aborted) {
      throw new UserQuestionError('ask_user_question was aborted before the user answered', 'ASK_ABORTED')
    }
    if (request.questions.length === 0) {
      throw new UserQuestionError('ask_user_question requires at least one question', 'EMPTY_QUESTIONS')
    }
    const agent = request.agent
    if (agent !== undefined) {
      const agents = this.ctx.get('agents')
      if (agents === undefined || agents.get(agent.id) !== agent) {
        throw new UserQuestionError(
          'human interaction requires the exact live calling agent when an agent is supplied',
          'CALLER_NOT_LIVE')
      }
      if (!agents.roots().includes(agent)) {
        throw new UserQuestionError(
          'human interaction is unavailable while the calling agent is owned by another live agent; '
          + "include the unresolved question or decision in the child agent's final result",
          'DELEGATED_CALLER')
      }
    }
    // A presentation intent asserts two things the types cannot: that the
    // named approve label is one of this question's own options, and that a
    // plan-review carries the plan it is a review of. A UI honouring the
    // intent answers with that label, and shows that detail as the plan, so
    // either gap would put a choice the asker never offered — or an approval of
    // something invisible — in front of the user. Caught at the asker, where
    // the mistake is, rather than in each UI.
    for (const question of request.questions) {
      const intent = question.intent
      if (intent === undefined) continue
      if (!(question.options ?? []).some(option => option.label === intent.approve)) {
        throw new UserQuestionError(
          `question ${question.id} declares intent ${intent.kind} whose approve label `
          + `${JSON.stringify(intent.approve)} names none of its options`,
          'BAD_INTENT')
      }
      if (question.detail === undefined) {
        throw new UserQuestionError(
          `question ${question.id} declares intent ${intent.kind} without the detail it reviews`,
          'BAD_INTENT')
      }
    }
    const candidates: UserQuestionProvider[] = []
    for (const router of this.routers) {
      if (router.accepts !== undefined && router.accepts(request)) candidates.push(router)
    }
    if (this.provider !== undefined) candidates.push(this.provider)
    if (candidates.length === 0) {
      throw new UserQuestionError('no user-questions provider is registered', 'NO_PROVIDER')
    }
    if (candidates.length === 1) {
      const single = candidates[0]
      /* v8 ignore next -- defensive: a non-empty array always has index 0 */
      if (single !== undefined) return single.ask(request)
    }
    // Fan-out: more than one UI can answer this request — a Feishu-bound agent
    // asked from chat while its Web session is open, for example. Offer it to
    // every candidate and let the first human answer win; the losers are
    // withdrawn through a derived abort signal once a winner settles, so a
    // later answer in another UI is inert.
    const settle = new AbortController()
    const signal = request.signal === undefined ? settle.signal : AbortSignal.any([request.signal, settle.signal])
    return new Promise<AskUserQuestionAnswer>((resolve, reject) => {
      let claimed = false
      let remaining = candidates.length
      for (const candidate of candidates) {
        // The extra microtask isolates a sync throw from one provider's `ask`
        // so a single bad candidate cannot pre-empt the others before they
        // are even offered the request.
        void Promise.resolve()
          .then(() => candidate.ask({ ...request, signal }))
          .then(
            (answer) => {
              if (claimed) return
              claimed = true
              settle.abort()
              resolve(answer)
            },
            (error: unknown) => {
              remaining -= 1
              if (!claimed && remaining === 0) {
                reject(error instanceof Error ? error : new Error(String(error)))
              }
            },
          )
      }
    })
  }
}

export default UserQuestionService
