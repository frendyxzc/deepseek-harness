/**
 * Feishu bot identity/mapping settings controller.
 *
 * The `feishu-bot` namespace is registered Host-side by
 * `@deepseek-ai/dsh-feishu-bot`; this browser half reads the resolved `bots`
 * list (id + appId + team/agent) and writes it back through the settings scope.
 * Secrets stay in the composition `credentials` key — they never ride this
 * branch, so a save cannot overwrite them.
 */

import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'

/** Settings namespace the owning Host plugin (`dsh-feishu-bot`) registers. */
export const FEISHU_BOT_SETTINGS_NAMESPACE = 'feishu-bot'

/** One bot as the editor drafts it. */
export interface TdaiBot {
  /** Stable bot id (the mapping key). */
  id: string
  /** Literal Feishu App ID; may be empty when the credential's env ref resolves it. */
  appId?: string
  /** TDAI team id, sent as `x-team-id`. */
  teamId?: string
  /** TDAI agent id, sent as `x-agent-id`. */
  agentId?: string
}

/** The `feishu-bot` settings section shape. */
export interface TdaiBotsSection {
  bots?: TdaiBot[]
}

/** Readable projection the editor renders. */
export interface TdaiBotsView {
  /** Whether the namespace is served to this client. */
  available: boolean
  /** Whether the Host document accepts writes. */
  writable: boolean
  /** The resolved bot list (schema-validated by the Host). */
  bots: readonly TdaiBot[]
}

/**
 * Read the section and route explicit writes for the `feishu-bot` namespace.
 * Reads are on-demand (the editor pulls on mount and after each save).
 */
export class TdaiBotsController {
  /**
   * @param scope - the bound settings scope for `feishu-bot`.
   */
  constructor(private readonly scope: SettingsScope<TdaiBotsSection>) {}

  /**
   * Load the current section, waiting out the mirror's first describe when it
   * has not settled yet.
   * @returns the readable projection.
   */
  load(): Promise<TdaiBotsView> {
    const ready = this.read()
    if (ready !== undefined) return Promise.resolve(ready)
    return new Promise((resolve) => {
      const off = this.scope.subscribe(() => {
        const view = this.read()
        if (view === undefined) return
        off()
        resolve(view)
      })
    })
  }

  /**
   * Replace the whole bot list. Absent optional fields are stripped so the
   * stored section carries only what the user filled in; secrets are never
   * present in the draft.
   * @param bots - the editor's draft list.
   * @returns settlement after the write and its mirror fold-back.
   */
  async save(bots: readonly TdaiBot[]): Promise<void> {
    await this.scope.set('bots', bots.map(bot => sanitize(bot)))
  }

  /** @returns the projection when the scope stands on a terminal state, else undefined. */
  private read(): TdaiBotsView | undefined {
    const snapshot = this.scope.getSnapshot()
    if (snapshot.status === 'ready') {
      return { available: true, writable: snapshot.writable, bots: snapshot.value?.bots ?? [] }
    }
    if (snapshot.status === 'unavailable') {
      return { available: false, writable: false, bots: [] }
    }
    return undefined
  }
}

/** Drop empty optional fields so a save stores only what the user typed. */
function sanitize(bot: TdaiBot): TdaiBot {
  const id = bot.id.trim()
  const appId = bot.appId?.trim()
  const teamId = bot.teamId?.trim()
  const agentId = bot.agentId?.trim()
  return {
    id,
    ...(appId ? { appId } : {}),
    ...(teamId ? { teamId } : {}),
    ...(agentId ? { agentId } : {}),
  }
}
