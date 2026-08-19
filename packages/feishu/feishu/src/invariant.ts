/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-feishu`.
 * @module @deepseek-ai/dsh-feishu/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-feishu'

/** Cordis companion plugin name. */
export const name = 'feishu-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the provider map is private, and the published
 * `feishu/provider-added` / `feishu/provider-removed` pair is emitted at the
 * single set/delete sites inside the registration effect generator, so the
 * pairing is mechanically guaranteed and no independent relationship remains
 * for the invariant to assert.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
