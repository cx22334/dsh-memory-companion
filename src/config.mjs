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
  const dshHomes = [path.join(os.homedir(), '.dsh'), process.env.DSH_HOME].filter(Boolean).map(dir => path.resolve(dir));
  if (dshHomes.some(dir => within(dir, vaultPath))) throw new MemoryError('VAULT_IN_DSH', '记忆库必须放在 DSH 家目录之外');
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
  config.vcpDsl = {
    maxDeclarations: 12, defaultThreshold: 0.6, defaultK: 5, maxK: 50,
    historySegmentLimit: 3, historyDecay: 0.85, associateMaxSeeds: 6, mainSearchWeights: [0.7, 0.3],
    books: {}, semanticGroups: { groups: {} }, pipeline: {}, river: {},
    ...input.vcpDsl
  };
  config.jev = { endpoint: '', model: '', apiKeyEnv: 'JEV_API_KEY', threshold: 0.7,
    maxCandidates: 12, concurrency: 4, timeoutMs: 4000, candidateChars: 1200, queryChars: 800,
    prompts: {}, ...input.jev };
  for (const [key, lo, hi] of [['maxDeclarations', 1, 50], ['defaultK', 1, 50], ['maxK', 1, 1000], ['historySegmentLimit', 0, 8], ['associateMaxSeeds', 1, 12]]) {
    config.vcpDsl[key] = bounded(config.vcpDsl[key], config.vcpDsl[key], lo, hi);
  }
  for (const [key, lo, hi] of [['maxCandidates', 1, 100], ['concurrency', 1, 16], ['timeoutMs', 100, 60000], ['candidateChars', 100, 16000], ['queryChars', 100, 8000]]) {
    config.jev[key] = bounded(config.jev[key], config.jev[key], lo, hi);
  }
  for (const n of [config.vcpDsl.defaultThreshold, config.vcpDsl.historyDecay, config.jev.threshold]) {
    if (!Number.isFinite(n) || n < 0 || n > 1) throw new MemoryError('INVALID_CONFIG', 'Thresholds and decay must be in [0,1]');
  }
  if (!Array.isArray(config.vcpDsl.mainSearchWeights) || config.vcpDsl.mainSearchWeights.length !== 2 || config.vcpDsl.mainSearchWeights.some(x => !Number.isFinite(x) || x < 0) || config.vcpDsl.mainSearchWeights.every(x => x === 0)) throw new MemoryError('INVALID_CONFIG', 'mainSearchWeights requires two nonnegative weights with positive sum');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(config.jev.apiKeyEnv) || 'apiKey' in config.jev || 'api_key' in config.jev) throw new MemoryError('INVALID_SECRET_REFERENCE', 'JEV key must use apiKeyEnv');
  if (config.jev.endpoint) {
    const url = new URL(config.jev.endpoint);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new MemoryError('INVALID_ENDPOINT', 'Invalid JEV endpoint');
  }
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
    vcpDsl: { enabled: true, syntax: 'VCP diary DSL', maxDeclarations: config.vcpDsl.maxDeclarations },
    jev: { configured: !!config.jev.endpoint && !!config.jev.model, model: config.jev.model, threshold: config.jev.threshold },
    google: { model: config.google.model, dimensions: config.google.dimensions, protocol: config.google.protocol },
    chat: { model: config.chat.model },
    security: { mode: config.security.mode, deploymentAcknowledged: config.security.deploymentAcknowledged }
  };
}

/** Runtime credentials live outside the portable vault and must be tool-inaccessible. */
export function managementAccessPath(config) {
  return path.resolve(config.management.accessFile || path.join(os.homedir(), '.config', 'dsh-memory-companion', 'runtime', `${hash(config.vaultPath).slice(0, 24)}.json`));
}
