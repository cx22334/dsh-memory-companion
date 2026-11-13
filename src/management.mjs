/** Loopback-only, user-authenticated management for the file-backed memory vault. */
import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, mkdir, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryError, id, now, safeSegment } from './common.mjs';
import { parseVcpText } from './vcp-dsl.mjs';

const UI_ROOT = fileURLToPath(new URL('../ui/', import.meta.url));
const BODY_LIMIT = 256 * 1024;
const SAFE_ACTIONS = new Set(['withdraw', 'exclude', 'restore', 'lock', 'unlock', 'usage', 'archive']);
const STATIC = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.mjs', ['app.mjs', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);

function sameSecret(actual, expected) {
  const a = Buffer.from(String(actual || ''));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function string(value, name, { optional = false, max = 512 } = {}) {
  if (value == null && optional) return undefined;
  if (typeof value !== 'string' || (!optional && !value.trim()) || value.length > max) {
    throw new MemoryError('INVALID_INPUT', `${name} 不合法。`);
  }
  return value;
}

function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new MemoryError('INVALID_INPUT', '请求正文必须是 JSON 对象。');
  }
  return value;
}

function strings(value, name, max = 100) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > max) throw new MemoryError('INVALID_INPUT', `${name} 必须是有限列表。`);
  return value.map(item => string(item, name, { max: 512 }));
}

async function body(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) {
    throw new MemoryError('UNSUPPORTED_MEDIA_TYPE', '请使用 application/json。');
  }
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > BODY_LIMIT) throw new MemoryError('BODY_TOO_LARGE', '请求内容过大。');
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > BODY_LIMIT) throw new MemoryError('BODY_TOO_LARGE', '请求内容过大。');
    chunks.push(chunk);
  }
  try { return object(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
  catch (error) {
    if (error instanceof MemoryError) throw error;
    throw new MemoryError('INVALID_JSON', '无法读取 JSON 请求。');
  }
}

function json(response, value, status = 200) {
  const text = JSON.stringify(value, (_key, item) => {
    if (typeof item === 'bigint') return item.toString();
    if (item instanceof Map) return Object.fromEntries(item);
    if (item instanceof Set) return [...item];
    return item;
  });
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(text);
}

function statusFor(code) {
  if (/NOT_FOUND|MISSING_NOTE|UNKNOWN_NOTE/.test(code)) return 404;
  if (/AUTH|FORBIDDEN|PERMISSION|OUT_OF_SCOPE|CSRF/.test(code)) return 403;
  if (/STALE|CONFLICT|REVISION_MISMATCH/.test(code)) return 409;
  if (/BODY_TOO_LARGE/.test(code)) return 413;
  if (/UNSUPPORTED_MEDIA/.test(code)) return 415;
  if (/NOT_READY|CORRUPT|UNAVAILABLE|CONTROL|PAUSED/.test(code)) return 503;
  if (/INVALID|REQUIRED|LIMIT|UNKNOWN_ROLE/.test(code)) return 400;
  return 500;
}

function publicConfig(config) {
  return {
    roles: config.roles.map(role => ({ id: role.id, name: role.name, alias: role.alias, directory: role.directory })),
    contextId: config.contextId,
    recall: config.recall,
    diary: config.diary,
    security: { mode: config.security?.mode, deploymentAcknowledged: !!config.security?.deploymentAcknowledged },
  };
}

async function managementBinding(service, input = {}) {
  const config = service.config;
  if (input.session_id) {
    const binding = await service.vault.getBinding(string(input.session_id, 'session_id'));
    if (!binding) throw new MemoryError('BINDING_NOT_READY', '没有找到这个会话的身份绑定。');
    if (input.role_id && input.role_id !== binding.role_id) throw new MemoryError('INVALID_INPUT', '会话与所选角色不一致。');
    return binding;
  }
  const role = config.roles.find(item => item.id === input.role_id);
  if (!role) throw new MemoryError('UNKNOWN_ROLE', '请选择已配置的角色。');
  const contextId = string(input.context_id || config.contextId || 'default', 'context_id');
  const sessionId = `management:${role.id}:${contextId}`;
  const current = await service.vault.getBinding(sessionId);
  if (current && current.role_id === role.id && current.context_id === contextId && current.read_public === true && current.allow_public === true && current.read_role_ids?.length === 1 && current.read_role_ids[0] === role.id) return current;
  return await service.vault.bind({
    binding_id: current?.binding_id || id('binding'),
    session_id: sessionId,
    branch_id: sessionId,
    role_id: role.id,
    context_id: contextId,
    read_role_ids: [role.id],
    read_public: true,
    allow_public: true,
    policy_revision: 'management-explicit-user',
    epoch: (current?.epoch || 0) + 1,
  });
}

async function changed(service) {
  await service.index.invalidate();
  await service.recall.invalidate();
}

/** Export names never become arbitrary filesystem paths. The configured root is an operator setting. */
async function exportDestination(config, requestedName) {
  const configured = config.management?.exportRoot || path.join(path.dirname(config.vaultPath), 'memory-exports');
  const root = path.resolve(configured);
  const vault = path.resolve(config.vaultPath);
  const rel = path.relative(vault, root);
  if (rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel))) {
    throw new MemoryError('INVALID_EXPORT_ROOT', '导出目录必须位于记忆库之外。');
  }
  let cursor = root;
  const parents = [];
  while (true) {
    parents.push(cursor);
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  for (const item of parents.reverse()) {
    try {
      const stat = await lstat(item);
      if (stat.isSymbolicLink()) throw new MemoryError('INVALID_EXPORT_ROOT', '导出路径不能经过符号链接或目录联接。');
      if (!stat.isDirectory()) throw new MemoryError('INVALID_EXPORT_ROOT', '导出路径不是目录。');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  const realRoot = await realpath(root);
  const label = requestedName ? safeSegment(string(requestedName, 'name', { max: 80 })) : 'memory';
  const basename = `${label}-${now().replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}`;
  const destination = path.join(realRoot, basename);
  if (path.dirname(destination) !== realRoot) throw new MemoryError('INVALID_EXPORT_NAME', '导出名称不合法。');
  return destination;
}

/**
 * Starts an authenticated user management endpoint. This is not an OS sandbox:
 * the deployment must keep these credentials away from model-controlled tools.
 * @param {object} service Assembled memory services.
 * @returns {Promise<object|null>} User URL, token and async close handle, or null when disabled.
 */
export async function startManagement(service) {
  const settings = service.config.management || {};
  if (settings.enabled === false) return null;
  const host = settings.host || '127.0.0.1';
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) throw new MemoryError('INVALID_MANAGEMENT_HOST', '管理服务只能监听本机回环地址。');
  const port = Number(settings.port ?? 0);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new MemoryError('INVALID_MANAGEMENT_PORT', '管理端口不合法。');
  const token = randomBytes(32).toString('base64url');
  const csrf = randomBytes(32).toString('base64url');
  const sockets = new Set();
  let origin;
  let expectedHost;
  let closing = false;

  const server = http.createServer({ maxHeaderSize: 16 * 1024 }, async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    try {
      if (closing || request.headers.host !== expectedHost) throw new MemoryError('FORBIDDEN_HOST', '管理地址不匹配。');
      if (request.headers.origin && request.headers.origin !== origin) throw new MemoryError('FORBIDDEN_ORIGIN', '不接受跨站请求。');
      if (request.headers['sec-fetch-site'] === 'cross-site') throw new MemoryError('FORBIDDEN_ORIGIN', '不接受跨站请求。');
      const url = new URL(request.url, origin);
      if (url.origin !== origin) throw new MemoryError('FORBIDDEN_ORIGIN', '请求地址不匹配。');
      if (request.method === 'GET' && STATIC.has(url.pathname)) {
        const [file, contentType] = STATIC.get(url.pathname);
        const bytes = await readFile(path.join(UI_ROOT, file));
        response.writeHead(200, { 'Content-Type': contentType });
        response.end(bytes);
        return;
      }
      if (!url.pathname.startsWith('/api/')) { json(response, { error: { code: 'NOT_FOUND', message: '没有这个页面。' } }, 404); return; }
      const authorization = request.headers.authorization || '';
      if (!authorization.startsWith('Bearer ') || !sameSecret(authorization.slice(7), token)) {
        json(response, { error: { code: 'AUTH_REQUIRED', message: '请从插件提供的管理链接进入，或输入本次访问令牌。' } }, 401);
        return;
      }
      if (!['GET', 'POST'].includes(request.method)) { json(response, { error: { code: 'METHOD_NOT_ALLOWED', message: '不支持该请求方式。' } }, 405); return; }
      if (request.method === 'POST' && !sameSecret(request.headers['x-csrf-token'], csrf)) throw new MemoryError('CSRF_REQUIRED', '页面授权已过期，请重新连接。');
      const query = Object.fromEntries(url.searchParams);
      const input = request.method === 'POST' ? await body(request) : query;
      const route = `${request.method} ${url.pathname}`;
      let result;

      switch (route) {
        case 'GET /api/state':
          result = { config: publicConfig(service.config), health: await service.health(), csrfToken: csrf, serverTime: now() };
          break;
        case 'GET /api/notes': {
          const notes = await service.vault.listNotes({ role_id: query.role_id || undefined, context_id: query.context_id || undefined, includeInactive: true });
          const needle = (query.q || '').toLocaleLowerCase().slice(0, 200);
          const filtered = notes.filter(note => !needle || `${note.body}\n${(note.tags || []).join(' ')}`.toLocaleLowerCase().includes(needle));
          const offset = Math.max(0, Math.min(1_000_000, Number(query.offset) || 0));
          const limit = Math.max(1, Math.min(200, Number(query.limit) || 100));
          result = { items: filtered.slice(offset, offset + limit), total: filtered.length, offset, limit };
          break;
        }
        case 'GET /api/note': {
          const note = await service.vault.getNote(string(query.id, 'id'), query.revision || undefined);
          if (!note) throw new MemoryError('NOT_FOUND', '日记不存在。');
          const relations = await service.vault.relations();
          result = { note, relations: relations.filter(item => item.from?.note_id === note.note_id || item.to?.note_id === note.note_id) };
          break;
        }
        case 'GET /api/event': {
          result = await service.vault.getEvent(string(query.id, 'id'));
          if (!result) throw new MemoryError('NOT_FOUND', '原文事件不存在。');
          break;
        }
        case 'GET /api/events':
          result = await service.vault.listEvents({ session_id: query.session_id || undefined, role_id: query.role_id || undefined, context_id: query.context_id || undefined, limit: Math.min(200, Math.max(1, Number(query.limit) || 50)) });
          break;
        case 'GET /api/proposals': result = await service.vault.listProposals(); break;
        case 'GET /api/relations': result = await service.vault.relations(); break;
        case 'GET /api/snapshots': result = await service.vault.listSnapshots({ session_id: query.session_id || undefined, limit: 100 }); break;
        case 'POST /api/note': {
          const noteBody = string(input.body, 'body', { max: 128 * 1024 });
          const tags = strings(input.tags, 'tags', 30);
          const facets = strings(input.facets, 'facets', 20);
          if (input.note_id) {
            result = await service.vault.editNote(string(input.note_id, 'note_id'), string(input.expected_revision, 'expected_revision'), noteBody, { tags, facets });
          } else {
            const binding = await managementBinding(service, input);
            const kind = ['diary', 'impression', 'public'].includes(input.kind) ? input.kind : 'diary';
            result = await service.vault.appendNote({ body: noteBody, tags, facets, kind, stance: 'observation', sources: [], context_id: binding.context_id }, binding, { origin: 'user', user: true, idempotencyKey: string(input.operation_key, 'operation_key') });
          }
          await changed(service);
          break;
        }
        case 'POST /api/action': {
          const action = string(input.action, 'action');
          if (!SAFE_ACTIONS.has(action)) throw new MemoryError('INVALID_ACTION', '不支持这项管理操作。');
          if (!Array.isArray(input.targets) || !input.targets.length || input.targets.length > 100) throw new MemoryError('INVALID_TARGETS', '请选择明确的条目修订。');
          const targets = input.targets.map(target => {
            const selected = { note_id: string(target.note_id, 'note_id'), revision_id: string(target.revision_id, 'revision_id') };
            if (target.body_spans !== undefined) {
              if (!Array.isArray(target.body_spans) || !target.body_spans.length || target.body_spans.length > 30) throw new MemoryError('INVALID_SPANS', '请选择明确的正文范围。');
              selected.body_spans = target.body_spans.map(span => {
                const start = span.start_utf8_byte;
                const end = span.end_utf8_byte;
                if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) throw new MemoryError('INVALID_SPANS', '正文范围不合法。');
                return { start_utf8_byte: start, end_utf8_byte: end };
              });
            }
            return selected;
          });
          const command = { action, targets, reason: string(input.reason, 'reason', { optional: true, max: 4000 }) || '', include_known_derivatives: input.include_known_derivatives !== false };
          if (input.approved_body !== undefined) {
            if (action !== 'withdraw' || targets.length !== 1) throw new MemoryError('INVALID_ACTION', '安全展示修订必须对应一条明确的撤回目标。');
            command.approved_body = string(input.approved_body, 'approved_body', { max: 128 * 1024 });
          }
          if (input.source_exclusions !== undefined) {
            if (!Array.isArray(input.source_exclusions) || input.source_exclusions.length > 100) throw new MemoryError('INVALID_SOURCES', '来源范围过多。');
            command.source_exclusions = input.source_exclusions;
          }
          if (input.usage_policy !== undefined) {
            if (!['normal', 'prefer_when_relevant', 'explicit_only', 'excluded'].includes(input.usage_policy)) throw new MemoryError('INVALID_USAGE', '使用策略不合法。');
            command.usage_policy = input.usage_policy;
          }
          if (input.restore_action_ids) command.restore_action_ids = strings(input.restore_action_ids, 'restore_action_ids');
          result = await service.vault.action(command);
          await changed(service);
          break;
        }
        case 'POST /api/proposal/decide': {
          if (!['approve', 'reject'].includes(input.decision)) throw new MemoryError('INVALID_DECISION', '请选择批准或拒绝。');
          result = await service.vault.decide(string(input.proposal_id, 'proposal_id'), input.decision, input.expected);
          await changed(service);
          break;
        }
        case 'POST /api/rebuild': result = await service.index.rebuild(input.role_id ? await managementBinding(service, input) : undefined); break;
        case 'POST /api/reconcile': result = await service.vault.reconcile(); await changed(service); break;
        case 'POST /api/backfill': result = await service.diary.backfill(await managementBinding(service, input), { force: true }); break;
        case 'POST /api/backfill/retry': result = await service.diary.retry(string(input.job_id, 'job_id'), await managementBinding(service, input), { acknowledgeUnknown: input.acknowledge_unknown === true }); break;
        case 'POST /api/organize': result = await service.diary.organize(await managementBinding(service, input), { note_ids: strings(input.note_ids, 'note_ids', 50), kind: string(input.kind || 'merge', 'kind', { max: 50 }) }); break;
        case 'POST /api/timeline': {
          const month = string(input.month, 'month');
          if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new MemoryError('INVALID_MONTH', '月份格式应为 YYYY-MM。');
          result = await service.diary.timeline(await managementBinding(service, input), { month, generate: input.generate === true });
          break;
        }
        case 'POST /api/replay': result = await service.diary.replay({ binding: await managementBinding(service, input), question: string(input.question, 'question', { max: 16000 }), snapshot_id: string(input.snapshot_id, 'snapshot_id', { optional: true }), modified_note_ids: strings(input.modified_note_ids, 'modified_note_ids', 30) }); break;
        case 'POST /api/preview': {
          const declaration = string(input.declaration, 'declaration', { optional: true, max: 8000 }) || '';
          const plans = parseVcpText(declaration, service.config).plans;
          result = await service.recall.recall({ binding: await managementBinding(service, input), turn_id: `management-preview:${randomBytes(16).toString('hex')}`, query: string(input.query, 'query', { max: 4000 }), context: [], explicit: input.explicit === true,
            plans, messageCounts: { user: 1, assistant: 0, system: 1 } });
          break;
        }
        case 'POST /api/export': result = await service.vault.exportTo(await exportDestination(service.config, input.name)); break;
        default: json(response, { error: { code: 'NOT_FOUND', message: '没有这个接口。' } }, 404); return;
      }
      json(response, { result });
    } catch (error) {
      if (response.headersSent) { response.destroy(); return; }
      const code = typeof error.code === 'string' ? error.code : 'INTERNAL_ERROR';
      json(response, { error: { code, message: error.message || '操作失败。', details: error.details } }, statusFor(code));
    }
  });
  server.requestTimeout = 5 * 60_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('clientError', (_error, socket) => { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  const displayHost = address.address.includes(':') ? `[${address.address}]` : address.address;
  expectedHost = `${displayHost}:${address.port}`;
  origin = `http://${expectedHost}`;
  return {
    url: `${origin}/#token=${encodeURIComponent(token)}`,
    baseUrl: origin,
    token,
    close: async () => {
      if (closing) return;
      closing = true;
      const done = new Promise(resolve => server.close(resolve));
      for (const socket of sockets) socket.destroy();
      await done;
    },
  };
}
