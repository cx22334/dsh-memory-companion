import path from 'node:path';
import os from 'node:os';
import { MemoryError, safeSegment, within, hash } from './common.mjs';

const bounded = (value, fallback, minimum, maximum) => {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number) || number < minimum || number > maximum) throw new MemoryError('INVALID_CONFIG', `Number must be between ${minimum} and ${maximum}`);
  return Math.floor(number);
};

/** Configuration contains environment-variable names, never actual provider secrets. */
export function normalizeConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new MemoryError('INVALID_CONFIG', '配置必须是对象');
  const vaultPath = path.resolve(input.vaultPath || path.join(os.homedir(), 'Documents', 'DSH-Memory'));
  if (within(path.join(os.homedir(), '.dsh'), vaultPath)) throw new MemoryError('VAULT_IN_DSH', '记忆库必须放在 .dsh 目录之外');
  const roles = (input.roles || []).map(role => {
    if (!role || typeof role !== 'object') throw new MemoryError('INVALID_ROLE', '角色配置无效');
    const roleId = safeSegment(role.id || role.role_id || '');
    const alias = String(role.alias || roleId).toLowerCase().replace(/-/gu, '_');
    if (!/^[a-z][a-z0-9_]*$/u.test(alias)) throw new MemoryError('INVALID_ROLE_ALIAS', '角色 alias 须匹配 DSH 变量规则');
    return { ...role, id: roleId, alias, name: String(role.name || roleId), directory: safeSegment(role.directory || role.name || roleId) };
  });
  for (const field of ['id', 'alias', 'directory']) {
    if (new Set(roles.map(role => role[field])).size !== roles.length) throw new MemoryError('DUPLICATE_ROLE', `角色 ${field} 不能重复`);
  }
  const google = input.google || {}, chat = input.chat || {}, recall = input.recall || {}, diary = input.diary || {}, management = input.management || {};
  const config = {
    ...input, vaultPath, roles,
    contextId: safeSegment(input.contextId || 'default'),
    timezone: input.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    google: {
      model: 'gemini-embedding-001', dimensions: 768, apiKeyEnv: 'GOOGLE_API_KEY',
      endpoint: 'https://generativelanguage.googleapis.com/v1beta', protocol: 'google',
      ...google, dimensions: bounded(google.dimensions, 768, 1, 65536)
    },
    chat: { model: '', endpoint: 'https://api.deepseek.com/v1', apiKeyEnv: 'DEEPSEEK_API_KEY', temperature: 0.35, ...chat },
    recall: {
      ...recall, engine: recall.engine || 'tagmemo', tokenBudget: bounded(recall.tokenBudget, 1200, 128, 16000),
      maxNotes: bounded(recall.maxNotes, 5, 1, 50), candidateLimit: bounded(recall.candidateLimit, 100, 5, 1000),
      timeoutMs: bounded(recall.timeoutMs, 1500, 100, 60000),
      historyBudget: bounded(recall.historyBudget, 4800, 256, 64000)
    },
    diary: {
      ...diary, enabled: diary.enabled !== false, maxPerTurn: bounded(diary.maxPerTurn, 2, 1, 20),
      batchTokens: bounded(diary.batchTokens, 4000, 256, 64000), maxNotes: bounded(diary.maxNotes, 6, 1, 50),
      dailyTokenBudget: bounded(diary.dailyTokenBudget, 20000, 0, 10000000),
      quietMs: bounded(diary.quietMs, 60000, 1000, 86400000), turnInterval: bounded(diary.turnInterval, 8, 1, 1000)
    },
    management: { ...management, enabled: management.enabled !== false, host: management.host || '127.0.0.1', port: bounded(management.port, 0, 0, 65535) },
    host: { contextOrder: 140, captureTools: false, persistenceBatchSize: 200, ...(input.host || {}) },
    security: { mode: 'host-enforced', deploymentAcknowledged: false, ...(input.security || {}) }
  };
  if (!['tagmemo', 'baseline'].includes(config.recall.engine)) throw new MemoryError('INVALID_ENGINE', '检索引擎必须是 tagmemo 或 baseline');
  if (!['google', 'openai-compatible'].includes(config.google.protocol)) throw new MemoryError('INVALID_EMBEDDING_PROTOCOL', '未知嵌入协议');
  if (!['127.0.0.1', '::1', 'localhost'].includes(config.management.host)) throw new MemoryError('MANAGEMENT_BIND', '管理界面只允许监听本机');
  for (const provider of [config.google, config.chat]) {
    const url = new URL(provider.endpoint);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new MemoryError('INVALID_ENDPOINT', '模型地址只接受不含凭据的 HTTP(S) URL');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(provider.apiKeyEnv)) throw new MemoryError('INVALID_SECRET_REFERENCE', '密钥必须通过环境变量名称配置');
    if ('apiKey' in provider || 'api_key' in provider) throw new MemoryError('INLINE_SECRET', '请使用 apiKeyEnv，不要把密钥写进记忆配置');
  }
  return config;
}

export function publicConfig(config) {
  return {
    vaultPath: config.vaultPath, roles: config.roles.map(({ persona, ...role }) => role), contextId: config.contextId,
    recall: config.recall, diary: config.diary,
    google: { model: config.google.model, dimensions: config.google.dimensions, protocol: config.google.protocol },
    chat: { model: config.chat.model },
    security: { mode: config.security.mode, deploymentAcknowledged: config.security.deploymentAcknowledged }
  };
}

/** Runtime credentials live outside the portable vault and must be tool-inaccessible. */
export function managementAccessPath(config) {
  return path.resolve(config.management.accessFile || path.join(os.homedir(), '.config', 'dsh-memory-companion', 'runtime', `${hash(config.vaultPath).slice(0, 24)}.json`));
}
