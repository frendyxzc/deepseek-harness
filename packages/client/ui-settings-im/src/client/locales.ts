/** Copy dictionaries for the IM status Settings section. */

/** Simplified Chinese dictionary and key source of truth. */
export const zh = {
  tab: 'IM',
  loading: '正在读取飞书状态…',
  error: '暂时无法读取飞书状态。',
  retry: '重试',
  heading: '飞书集成',
  connection: '连接状态',
  providerId: '提供方',
  appId: 'App ID',
  appSecret: 'App Secret',
  baseURL: 'Base URL',
  receiveActive: '接收消息',
  lastError: '最近错误',
  selectionError: '选择错误',
  stateConnected: '已连接',
  stateUnconfigured: '未配置',
  stateUnavailable: '不可用',
  stateUnconfiguredSdk: 'SDK 未配置',
  stateError: '错误',
  secretConfigured: '已配置',
  secretNotConfigured: '未配置',
  receiveActiveYes: '接收中',
  receiveActiveNo: '未接收',
  noProvider: '未配置飞书提供方。',
} satisfies Record<string, string>

/** IM status locale key union. */
export type ImStatusLocaleKey = keyof typeof zh

/** English dictionary checked against the Chinese key set. */
export const en = {
  tab: 'IM',
  loading: 'Reading Feishu status…',
  error: 'Feishu status is temporarily unavailable.',
  retry: 'Retry',
  heading: 'Feishu integration',
  connection: 'Connection',
  providerId: 'Provider',
  appId: 'App ID',
  appSecret: 'App secret',
  baseURL: 'Base URL',
  receiveActive: 'Receiving messages',
  lastError: 'Last error',
  selectionError: 'Selection error',
  stateConnected: 'Connected',
  stateUnconfigured: 'Unconfigured',
  stateUnavailable: 'Unavailable',
  stateUnconfiguredSdk: 'SDK unconfigured',
  stateError: 'Error',
  secretConfigured: 'Configured',
  secretNotConfigured: 'Not configured',
  receiveActiveYes: 'Active',
  receiveActiveNo: 'Inactive',
  noProvider: 'No Feishu provider is configured.',
} satisfies Record<ImStatusLocaleKey, string>
