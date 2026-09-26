/** TDAI memory identity: header mapping, config schema, and per-session binding. */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { FEISHU_BOT_SETTINGS_NAMESPACE } from '@deepseek-ai/dsh-feishu-bot'
import TdaiMemoryService, {
  AGENT_HEADER,
  Config,
  TASK_HEADER,
  tdaiMemoryHeaders,
  TEAM_HEADER,
} from '../src/index.ts'

describe('tdaiMemoryHeaders', () => {
  it('omits an absent identity entirely', () => {
    expect(tdaiMemoryHeaders(undefined)).toEqual({})
    expect(tdaiMemoryHeaders({})).toEqual({})
  })

  it('maps every populated id to its header and skips empty ones', () => {
    expect(tdaiMemoryHeaders({ teamId: 'team-t', agentId: '' })).toEqual({ [TEAM_HEADER]: 'team-t' })
    expect(tdaiMemoryHeaders({ teamId: 'team-t', agentId: 'agt-a' })).toEqual({
      [TEAM_HEADER]: 'team-t',
      [AGENT_HEADER]: 'agt-a',
    })
  })

  it('emits the task header only when a task id is supplied', () => {
    expect(tdaiMemoryHeaders({ teamId: 'team-t', agentId: 'agt-a' })).toEqual({
      [TEAM_HEADER]: 'team-t',
      [AGENT_HEADER]: 'agt-a',
    })
    expect(tdaiMemoryHeaders({ teamId: 'team-t', agentId: 'agt-a' }, '')).toEqual({
      [TEAM_HEADER]: 'team-t',
      [AGENT_HEADER]: 'agt-a',
    })
    expect(tdaiMemoryHeaders({ teamId: 'team-t', agentId: 'agt-a' }, 'none')).toEqual({
      [TEAM_HEADER]: 'team-t',
      [AGENT_HEADER]: 'agt-a',
      [TASK_HEADER]: 'none',
    })
  })
})

describe('Config', () => {
  it('defaults the whole catalog config to absent', () => {
    expect(Config({})).toEqual({
      endpoint: undefined,
      serviceId: undefined,
      serviceToken: undefined,
      userKeyEnv: undefined,
      defaultTaskId: undefined,
    })
  })
})

describe('TdaiMemoryService', () => {
  async function boot(
    bots: Array<{ id: string; teamId?: string; agentId?: string }>,
    config: Record<string, unknown> = {},
  ) {
    const ctx = new Context()
    // Stub of the Host settings form projection: identityFor reads the
    // `feishu-bot` entry's volatile form value.
    ctx.provide('settings', {
      describe: () => [{ ns: FEISHU_BOT_SETTINGS_NAMESPACE, value: { bots } }],
    } as never)
    await ctx.plugin(TdaiMemoryService, config)
    return ctx
  }

  it('resolves a bound session against the merged feishu-bot mapping plus the default task', async () => {
    const ctx = await boot([{ id: 'bot-a', teamId: 'team-t', agentId: 'agt-a' }])
    const svc = ctx.tdaiMemory
    expect(svc.headersFor('bot-a')).toEqual({
      [TEAM_HEADER]: 'team-t',
      [AGENT_HEADER]: 'agt-a',
      [TASK_HEADER]: 'none',
    })
    expect(svc.headersFor('bot-unknown')).toEqual({})

    svc.bindSession('session-1', 'bot-a')
    expect(svc.headersForSession('session-1')).toEqual({
      [TEAM_HEADER]: 'team-t',
      [AGENT_HEADER]: 'agt-a',
      [TASK_HEADER]: 'none',
    })
    expect(svc.headersForSession('session-unbound')).toEqual({})
    await ctx.fiber.dispose()
  })

  it('pins the task to the configured defaultTaskId', async () => {
    const ctx = await boot([{ id: 'bot-a', teamId: 'team-t', agentId: 'agt-a' }], { defaultTaskId: 'tsk-k' })
    const svc = ctx.tdaiMemory
    svc.bindSession('session-1', 'bot-a')
    expect(svc.headersForSession('session-1')).toEqual({
      [TEAM_HEADER]: 'team-t',
      [AGENT_HEADER]: 'agt-a',
      [TASK_HEADER]: 'tsk-k',
    })
    await ctx.fiber.dispose()
  })
})
