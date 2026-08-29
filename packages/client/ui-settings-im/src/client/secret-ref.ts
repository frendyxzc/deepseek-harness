/**
 * Client mirror of `feishuAppSecretRef` in `@deepseek-ai/dsh-feishu-bot`.
 *
 * A Settings write for one bot's App Secret must land under the reference the
 * Host provider resolves for that bot. The Host owns the derivation (it names
 * the reference it reads), while this client half derives the same reference so
 * an unsaved bot can be given its secret in one save, before the Host has
 * registered the provider and reported a status. Keep the two functions in
 * sync; each package pins the same outputs in its own tests.
 */

/** The flat single-app provider id, which keeps the conventional shared reference. */
const FLAT_PROVIDER_ID = 'feishu-bot'

/**
 * Derive the per-bot App Secret reference the Host resolves when the
 * composition names none.
 * @param botId - the bot's registry id.
 * @returns the App Secret credential reference name.
 */
export function feishuAppSecretRef(botId: string): string {
  if (botId === FLAT_PROVIDER_ID) return 'FEISHU_APP_SECRET'
  const suffix = botId.toUpperCase().replace(/[^A-Za-z0-9]+/g, '_')
  const safe = suffix.length === 0 || /^[0-9]/.test(suffix) ? `BOT_${suffix}` : suffix
  return `FEISHU_APP_SECRET_${safe}`
}
