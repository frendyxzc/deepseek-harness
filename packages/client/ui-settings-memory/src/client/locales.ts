/** Copy dictionaries for the Memory panel settings section. */

/** English strings (the key-set source of truth for this pair). */
export const en = {
  nav: 'Memory',
  title: 'Memory Hub',
  intro: 'Open the TencentDB-Agent-Memory panel to view and manage chat memories, skills, code graphs, and team assets.',
  open: 'Open memory panel',
  urlLabel: 'Panel URL',
}

/** The settings.memory namespace key union. */
export type MemoryKey = keyof typeof en

/** Chinese strings (same keys as {@link en}). */
export const zh: { [Key in keyof typeof en]: string } = {
  nav: '记忆',
  title: '记忆面板',
  intro: '打开 TencentDB-Agent-Memory 面板，查看和管理会话记忆、技能、代码图谱与团队资产。',
  open: '打开记忆面板',
  urlLabel: '面板地址',
}
