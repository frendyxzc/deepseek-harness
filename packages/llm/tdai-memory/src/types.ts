/**
 * Client-safe type surface of the TDAI memory catalog Remote. Types only —
 * nothing here reaches a Host-only symbol, so the generated Remote face and the
 * browser configuration UI read the same catalog option shapes.
 * @module @deepseek-ai/dsh-tdai-memory/types
 */

/** One team the dropdown can offer. */
export interface TdaiTeamOption {
  /** Team id, stored as `teamId`. */
  teamId: string
  /** Human-readable team name. */
  name: string
}

/** One agent the dropdown can offer. */
export interface TdaiAgentOption {
  /** Agent id, stored as `agentId`. */
  agentId: string
  /** Human-readable agent name. */
  name: string
}
