/**
 * The Host-side App Secret reference derivation. The Settings IM tab mirrors
 * this rule in `dsh-client-ui-settings-im`; these outputs are pinned on both
 * sides so a drift in either half fails one of the two suites.
 */

import { describe, expect, it } from 'vitest'
import { feishuAppSecretRef } from '../src/index.ts'

describe('feishuAppSecretRef', () => {
  it('keeps the flat single-app provider on the conventional reference', () => {
    expect(feishuAppSecretRef('feishu-bot')).toBe('FEISHU_APP_SECRET')
  })

  it('derives a per-bot reference from the bot id', () => {
    expect(feishuAppSecretRef('main')).toBe('FEISHU_APP_SECRET_MAIN')
    expect(feishuAppSecretRef('bot-a')).toBe('FEISHU_APP_SECRET_BOT_A')
    expect(feishuAppSecretRef('chat bot 2')).toBe('FEISHU_APP_SECRET_CHAT_BOT_2')
  })

  it('prefixes ids that sanitize to empty or start with a digit', () => {
    expect(feishuAppSecretRef('123')).toBe('FEISHU_APP_SECRET_BOT_123')
    expect(feishuAppSecretRef('')).toBe('FEISHU_APP_SECRET_BOT_')
  })
})
