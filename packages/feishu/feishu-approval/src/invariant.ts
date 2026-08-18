/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-feishu-approval`.
 * @module @deepseek-ai/dsh-feishu-approval/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-feishu-approval'

/** Cordis companion plugin name. */
export const name = 'feishu-approval-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the one-time nonce → decision relation is private
 * operational state with no authoritative event stream of its own; the
 * durable approval audit (`approval/asked` + `approval/decided`) belongs to
 * `@deepseek-ai/dsh-user-approval` and is asserted there.
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
