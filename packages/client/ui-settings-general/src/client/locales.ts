/** Shell chrome and General-nav dictionaries; feature rows own their copy. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'trigger': '设置',
  'title': '设置',
  'close': '关闭',
  'openDocument': '打开配置文件',
  'openDocument.error': '无法打开配置文件',
  'general.nav': '通用设置',
  'loopbackNotice': '当前通过局域网连接，配置与凭据仅限本机访问。请在本机浏览器打开，或使用 SSH 隧道（ssh -L 3080:127.0.0.1:3080 <机器>）后访问 http://localhost:3080。',
} satisfies Record<string, string>

/** The settings namespace key union. */
export type SettingsKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'trigger': 'Settings',
  'title': 'Settings',
  'close': 'Close',
  'openDocument': 'Open configuration file',
  'openDocument.error': 'Could not open configuration file',
  'general.nav': 'General',
  'loopbackNotice': 'Settings and credentials are local-only over the LAN. Open this page in a browser on the host machine, or use an SSH tunnel (ssh -L 3080:127.0.0.1:3080 <host>) and visit http://localhost:3080.',
} satisfies Record<SettingsKey, string>
