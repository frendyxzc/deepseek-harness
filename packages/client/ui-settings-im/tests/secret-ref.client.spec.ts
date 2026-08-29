/**
 * The client-side App Secret reference derivation must stay byte-for-byte in
 * sync with `@deepseek-ai/dsh-feishu-bot` so a Settings write lands under the
 * reference the Host provider resolves.
 */

import { describe, expect, it } from 'vitest'
import { feishuAppSecretRef } from '../src/client/secret-ref.ts'

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
