/**
 * Host-side composition resolution: a named bot must resolve its App Secret
 * under its per-id reference (`feishuAppSecretRef`), never the flat single-app
 * `FEISHU_APP_SECRET`, when no composition `credentials` entry names it.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import FeishuRuntime from '@deepseek-ai/dsh-feishu'
import * as FeishuBot from '../src/index.ts'

describe('feishu-bot multi-bot credential resolution', () => {
  it('declares credentials in its inject so file-backed secrets load before providers register', () => {
    // The credential store loads `.credentials.yaml` asynchronously; declaring
    // the dependency forces Cordis to finish that load before `apply` registers
    // providers, so a boot-time receive channel never reads an empty store.
    expect(FeishuBot.inject).toEqual(['feishu', 'credentials'])
  })

  it('resolves a named bot App Secret under its per-id reference, not the flat reference', async () => {
    const ctx = new Context()
    await ctx.plugin(FeishuRuntime, {})

    const resolved: string[] = []
    ctx.provide('credentials', {
      resolve: async (ref: string) => {
        resolved.push(ref)
        return ref === 'FEISHU_APP_SECRET_QA' ? { value: 'qa-secret', source: 'file' } : undefined
      },
    } as never)

    const fiber = await ctx.plugin(FeishuBot, { bots: [{ id: 'qa', appId: 'cli_aa2d297272b85d0c' }] })

    const provider = ctx.feishu.listProviders()[0]!
    // status() resolves the App Secret so the reference it asks for is observed.
    await expect(provider.status?.()).resolves.toMatchObject({ state: 'connected' })
    expect(resolved).toContain('FEISHU_APP_SECRET_QA')
    expect(resolved).not.toContain('FEISHU_APP_SECRET')

    await fiber.dispose()
    await ctx.fiber.dispose()
  })
})
