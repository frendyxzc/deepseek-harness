/**
 * Package-owned invariant companion for the TDAI memory identity.
 *
 * The plugin owns no durable event/data relationship: the settings service
 * validates the bot list before `identityFor` can observe it, and the per-session
 * app binding is an in-memory key/value pair whose only consequence — the
 * request headers — is asserted by the adapter tests. The empty installer keeps
 * that absence explicit in composed invariant sets.
 *
 * @module @deepseek-ai/dsh-tdai-memory/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-tdai-memory'

/** Cordis companion plugin name. */
export const name = 'tdai-memory-invariant'
/** Services required before the companion can register. */
export const inject = ['invariants']

/** No runtime invariant: settings validation and the adapter header tests own the mutable relationships. */
const install: InvariantInstaller = () => {}

/**
 * Register the intentionally empty invariant contribution.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
