/**
 * TDAI MemoryProxy team/agent identity for outgoing LLM requests, resolved per
 * Feishu bot and bound per agent session.
 *
 * The per-bot team/agent mapping now lives in the `feishu-bot` settings section
 * (each bot entry carries its own `teamId` / `agentId`), so this package owns
 * only the runtime coordination: `ctx.tdaiMemory` holds the session → bot
 * bindings `feishu-receive` writes, resolves a session's bot back to its
 * team/agent headers for the `llm-pi-ai` / `llm-deepseek` adapters, and exposes
 * the TDAI core's team/agent catalog as Typert Remotes so the configuration UI
 * can offer dropdowns instead of free-text ids.
 *
 * Every bound session also carries the default task as `x-task-id` (see
 * `Config.defaultTaskId`): the proxy's header auto-select requires team + agent
 * + task together before it registers a session directly, and absent a task a
 * single-agent team falls into the proxy's bypass path and never writes memory.
 *
 * @module @deepseek-ai/dsh-tdai-memory
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { FeishuBotEntry } from '@deepseek-ai/dsh-feishu-bot'
import { FEISHU_BOT_SETTINGS_NAMESPACE } from '@deepseek-ai/dsh-feishu-bot'
import type {} from '@deepseek-ai/dsh-settings'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { TdaiAgentOption, TdaiTeamOption } from './types.ts'
// Typert-generated ./typert and ./remote artifacts import Zod at runtime.
import type {} from 'zod'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Per-bot TDAI memory identity, its per-session bindings, and its catalog Remote. */
    tdaiMemory: TdaiMemoryService
  }
}

/** Outbound header names the proxy's `sessionInit.headerAutoSelect` reads. */
export const TEAM_HEADER = 'x-team-id'
/** Outbound agent id header the proxy's `sessionInit.headerAutoSelect` reads. */
export const AGENT_HEADER = 'x-agent-id'
/**
 * Task header the proxy's header auto-select requires alongside team/agent
 * before it can register a session directly (`resolvePresetIdentity` needs all
 * three). Emitted from this plane as the configured default task, mirroring the
 * proxy's `sessionInit.defaultTaskId` virtual "no task" entry.
 */
export const TASK_HEADER = 'x-task-id'

/** Default TDAI core endpoint the catalog is read from. */
const DEFAULT_ENDPOINT = 'http://127.0.0.1:8420'
/** Default core tenant/service id sent on catalog requests. */
const DEFAULT_SERVICE_ID = 'default'
/** Default core service token sent on catalog requests. */
const DEFAULT_SERVICE_TOKEN = 'local'
/** Default credential reference naming the core user key. */
const DEFAULT_USER_KEY_ENV = 'PROXY_USER_KEY'
/**
 * Protocol default task id: the core pre-seeds every team with this virtual
 * "no task" entry (`isDefault: true`), and the proxy references it as
 * `sessionInit.defaultTaskId`. Kept as a fallback so an unpinned composition
 * still resolves a task; deployments pin a real default through
 * `Config.defaultTaskId`.
 */
const DEFAULT_TASK_ID = 'none'

/** Composition config for the TDAI core catalog the Remote reads from. */
export interface Config {
  /** TDAI core base URL. */
  endpoint?: string
  /** Core tenant/service id sent on catalog requests. */
  serviceId?: string
  /** Core service token sent on catalog requests. */
  serviceToken?: string
  /** Credential reference naming the core user key (`sk-mem-*`). */
  userKeyEnv?: string
  /**
   * Default task id sent as `x-task-id` for every bound session. The proxy's
   * header auto-select refuses to register directly without team + agent + task,
   * so a deployment with single-agent teams must pin this (typically the proxy's
   * own `sessionInit.defaultTaskId`) or the session falls into the bypass path
   * and never writes memory.
   */
  defaultTaskId?: string
}

export const Config: z<Config> = z.object({
  endpoint: z.string(),
  serviceId: z.string(),
  serviceToken: z.string(),
  userKeyEnv: z.string().role('credential-ref'),
  defaultTaskId: z.string(),
})

/** Resolved team/agent identity for one bot; absent ids are omitted from the wire. */
export interface TdaiIdentity {
  teamId?: string
  agentId?: string
}

/**
 * Build the identity headers from one bot's resolved identity plus the default
 * task. Absent/empty fields are omitted so an unpinned bot sends no identity
 * header at all. Team, agent, and task ride together: the proxy's header
 * auto-select requires all three before it registers a session directly, and a
 * single-agent team otherwise falls into its bypass path.
 * @param identity - the bot's resolved identity, or `undefined`.
 * @param taskId - default task sent as `x-task-id`, or `undefined`.
 * @returns the non-empty `x-team-id` / `x-agent-id` / `x-task-id` headers.
 */
export function tdaiMemoryHeaders(identity: TdaiIdentity | undefined, taskId?: string): Record<string, string> {
  const headers: Record<string, string> = {}
  if (identity?.teamId) headers[TEAM_HEADER] = identity.teamId
  if (identity?.agentId) headers[AGENT_HEADER] = identity.agentId
  if (taskId) headers[TASK_HEADER] = taskId
  return headers
}

/** One core catalog envelope (`/v3/meta/*`). */
interface CoreEnvelope {
  code?: number
  message?: string
  data?: { items?: Array<Record<string, unknown>> }
}

/** One core team entity. */
interface CoreTeam {
  team_id?: unknown
  name?: unknown
}

/** One core agent entity. */
interface CoreAgent {
  agent_id?: unknown
  name?: unknown
}

/**
 * Owns the session → bot bindings the Feishu receive channel writes, the
 * team/agent header resolution the LLM adapters read, and the TDAI core catalog
 * Remote the configuration UI reads for its dropdowns.
 */
export class TdaiMemoryService extends TypertRemoteService {
  static Config: z<Config> = Config

  private readonly config: Config
  private readonly sessionBots = new Map<string, string>()

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'tdaiMemory')
    this.config = config
  }

  /**
   * Resolved team/agent identity for one bot, read from the `feishu-bot` section.
   * @param botId - the Feishu bot id whose identity to resolve.
   * @returns the bot's team/agent identity, or undefined when the bot is unmapped.
   */
  identityFor(botId: string): TdaiIdentity | undefined {
    const settings = this.ctx.get('settings')
    const section = settings?.get(FEISHU_BOT_SETTINGS_NAMESPACE) as { bots?: FeishuBotEntry[] } | undefined
    return section?.bots?.find(bot => bot.id === botId)
  }

  /** The configured default task, or the protocol `none` fallback. */
  private resolveTaskId(): string {
    const taskId = this.config.defaultTaskId ?? DEFAULT_TASK_ID
    return taskId.trim()
  }

  /**
   * Headers for one bot, from its merged identity and the default task.
   * @param botId - the Feishu bot id whose headers to build.
   * @returns the TDAI headers for the bot's identity and default task, or an empty map when the bot is unmapped.
   */
  headersFor(botId: string): Record<string, string> {
    const identity = this.identityFor(botId)
    return identity === undefined ? {} : tdaiMemoryHeaders(identity, this.resolveTaskId())
  }

  /**
   * Bind one agent session to the bot that received it, so the LLM adapters
   * resolve that session's requests to the bot's team/agent headers.
   * @param sessionId - the session id the loop stamps on its requests.
   * @param botId - the Feishu bot id the session belongs to.
   */
  bindSession(sessionId: string, botId: string): void {
    this.sessionBots.set(sessionId, botId)
  }

  /**
   * Headers for one agent session: its bound bot's merged identity, or an empty
   * set when the session was never bound (a non-Feishu session) or the bot is
   * unmapped.
   * @param sessionId - the session id the loop stamped on its request.
   * @returns the TDAI headers for the session's bound bot, or an empty map when unbound.
   */
  headersForSession(sessionId: string): Record<string, string> {
    const botId = this.sessionBots.get(sessionId)
    return botId === undefined ? {} : this.headersFor(botId)
  }

  /**
   * The teams the core catalog serves, for the configuration dropdown.
   * @returns the teams the core catalog serves.
   */
  @Remote('listTeams')
  async listTeams(): Promise<TdaiTeamOption[]> {
    const items = await this.fetchCore('/v3/meta/team/list', { user_key: await this.userKey() })
    return items.map(item => teamOption(item as CoreTeam)).filter((option): option is TdaiTeamOption => option !== undefined)
  }

  /**
   * The agents one team serves, for the configuration dropdown.
   * @param teamId - the team id whose agents to list.
   * @returns the team's active agents.
   */
  @Remote('listAgents')
  async listAgents(teamId: string): Promise<TdaiAgentOption[]> {
    const items = await this.fetchCore('/v3/meta/agent/list', { team_id: teamId, status: 'active' })
    return items.map(item => agentOption(item as CoreAgent)).filter((option): option is TdaiAgentOption => option !== undefined)
  }

  /** Resolve the credential naming the core user key. */
  private async userKey(): Promise<string> {
    const ref = credentialRef(this.config.userKeyEnv ?? DEFAULT_USER_KEY_ENV)
    const credentials = this.ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(ref)
      if (hit !== undefined && hit.value.length > 0) return hit.value
    }
    throw new Error(`tdai-memory: no TDAI core user key (set ${DEFAULT_USER_KEY_ENV})`)
  }

  /** POST one core catalog request and return its item list. */
  private async fetchCore(path: string, body: Record<string, unknown>): Promise<Array<Record<string, unknown>>> {
    const endpoint = this.config.endpoint ?? DEFAULT_ENDPOINT
    const userKey = await this.userKey()
    const response = await fetch(new URL(`${endpoint.replace(/\/$/, '')}${path}`), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${this.config.serviceToken ?? DEFAULT_SERVICE_TOKEN}`,
        'x-tdai-service-id': this.config.serviceId ?? DEFAULT_SERVICE_ID,
        'x-tdai-user-key': userKey,
      },
      body: JSON.stringify(body),
    })
    if (!response.ok) throw new Error(`tdai-memory: core ${path} returned HTTP ${response.status}`)
    const envelope = await response.json() as CoreEnvelope
    if (envelope.code !== 0) throw new Error(`tdai-memory: core ${path} failed: ${envelope.message ?? String(envelope.code)}`)
    return envelope.data?.items ?? []
  }
}

/** Project one core team entity into a dropdown option. */
function teamOption(team: CoreTeam): TdaiTeamOption | undefined {
  if (typeof team.team_id !== 'string' || typeof team.name !== 'string') return undefined
  return { teamId: team.team_id, name: team.name }
}

/** Project one core agent entity into a dropdown option. */
function agentOption(agent: CoreAgent): TdaiAgentOption | undefined {
  if (typeof agent.agent_id !== 'string' || typeof agent.name !== 'string') return undefined
  return { agentId: agent.agent_id, name: agent.name }
}

export default TdaiMemoryService
