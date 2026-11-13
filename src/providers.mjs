import { MemoryError, canonical, hash } from './common.mjs';

/**
 * Bounded REST transports. No provider call is retried automatically: an
 * interrupted generation can have an unknown, billable upstream outcome.
 * Embedding batching/cache ordering follows the dsh-vcprag embed.js approach
 * (MIT, Nova & 辉宝主人), with strict duplicate-index and dimension checks.
 * Native Google payload: https://ai.google.dev/api/embeddings
 */

function endpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw new MemoryError('PROVIDER_CONFIG', '模型端点不是有效 URL。'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))) {
    throw new MemoryError('PROVIDER_CONFIG', '模型端点须为 HTTPS；本机端点可用 HTTP，不能在 URL 中包含凭据或查询参数。');
  }
  return url.href.replace(/\/+$/, '');
}

function keyFromEnvironment(name, optional = false) {
  if (!name && optional) return '';
  if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new MemoryError('PROVIDER_CONFIG', 'API 密钥必须通过有效的环境变量名称配置。');
  }
  const value = process.env[name];
  if (!value && !optional) throw new MemoryError('PROVIDER_NOT_CONFIGURED', `缺少环境变量 ${name}。`);
  return value || '';
}

async function jsonRequest(url, body, headers, { signal, timeoutMs = 120000, maxResponseBytes = 8388608 } = {}) {
  if (signal?.aborted) throw new MemoryError('CANCELLED', '请求已取消。');
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('Provider deadline exceeded')), timeoutMs);
  timer.unref?.();
  let sent = false;
  try {
    sent = true;
    const response = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body), signal: controller.signal, redirect: 'error',
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new MemoryError('PROVIDER_HTTP', `模型端点返回 HTTP ${response.status}。`, { status: response.status, dispatched: true });
    }
    const length = Number(response.headers.get('content-length'));
    if (length > maxResponseBytes) {
      await response.body?.cancel();
      throw new MemoryError('PROVIDER_RESPONSE_LIMIT', '模型响应超过允许大小。', { dispatched: true });
    }
    const reader = response.body?.getReader();
    if (!reader) throw new MemoryError('PROVIDER_RESPONSE', '模型端点没有返回响应内容。', { dispatched: true });
    const chunks = [];
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxResponseBytes) {
          await reader.cancel();
          throw new MemoryError('PROVIDER_RESPONSE_LIMIT', '模型响应超过允许大小。', { dispatched: true });
        }
        chunks.push(Buffer.from(value));
      }
    } finally { reader.releaseLock(); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new MemoryError('PROVIDER_RESPONSE', '模型端点返回的内容不是 JSON。', { dispatched: true }); }
  } catch (error) {
    if (error instanceof MemoryError) throw error;
    throw new MemoryError(signal?.aborted ? 'CANCELLED' : controller.signal.aborted ? 'PROVIDER_TIMEOUT' : 'PROVIDER_NETWORK',
      signal?.aborted ? '请求已取消；已派发调用的结果可能未知。' : '模型请求未取得完整结果；不会自动重新派发。',
      { dispatched: sent, outcome_unknown: sent });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

function normalizeVector(value, dimensions, normalize) {
  if (!Array.isArray(value) || value.length !== dimensions || value.some(n => typeof n !== 'number' || !Number.isFinite(n))) {
    throw new MemoryError('EMBEDDING_DIMENSIONS', '嵌入向量缺失、非有限值或维度与配置不符。');
  }
  const norm = Math.sqrt(value.reduce((sum, n) => sum + n * n, 0));
  if (!Number.isFinite(norm) || norm <= 0) throw new MemoryError('EMBEDDING_ZERO_VECTOR', '嵌入端点返回了无效的零向量。');
  return normalize ? value.map(n => n / norm) : [...value];
}

/** Google embeddings through the native API or an explicitly selected compatible gateway. */
export class GoogleEmbedding {
  constructor(config) {
    this.config = config.google || config;
    this.cache = new Map();
    this.requests = 0;
    this.errors = 0;
    this.protocol = this.config.protocol || 'google';
    if (!['google', 'openai-compatible'].includes(this.protocol)) throw new MemoryError('PROVIDER_CONFIG', '未知的 Google 嵌入协议。');
  }

  get configured() {
    return Boolean(this.config.model && Number.isInteger(this.config.dimensions) && this.config.dimensions > 0
      && process.env[this.config.apiKeyEnv || 'GOOGLE_API_KEY']);
  }

  signature() {
    return { provider: 'google', protocol: this.protocol, model: this.config.model, dimensions: this.config.dimensions,
      endpoint: this.config.endpoint || 'https://generativelanguage.googleapis.com/v1beta',
      query_task_type: this.config.queryTaskType || 'RETRIEVAL_QUERY',
      document_task_type: this.config.documentTaskType || 'RETRIEVAL_DOCUMENT',
      normalization: this.config.normalization === 'none' ? 'none' : 'l2' };
  }

  async embed(text, options = {}) { return (await this.embedMany([text], { task: 'query', ...options }))[0]; }

  async embedMany(texts, { task = 'document', signal } = {}) {
    if (!Array.isArray(texts) || texts.some(t => typeof t !== 'string' || !t.trim())) throw new MemoryError('EMBEDDING_INPUT', '嵌入输入必须是非空文本数组。');
    if (!texts.length) return [];
    if (!this.configured) throw new MemoryError('PROVIDER_NOT_CONFIGURED', '请配置 Google 嵌入模型、维度和密钥环境变量。');
    if (!['query', 'document'].includes(task)) throw new MemoryError('EMBEDDING_INPUT', '嵌入任务必须为 query 或 document。');
    const output = new Array(texts.length);
    const pending = [];
    for (let i = 0; i < texts.length; i++) {
      const cacheKey = hash(canonical([this.signature(), task, texts[i]]));
      const cached = this.cache.get(cacheKey);
      if (cached) { this.cache.delete(cacheKey); this.cache.set(cacheKey, cached); output[i] = [...cached]; }
      else pending.push({ index: i, key: cacheKey, text: texts[i] });
    }
    const batchSize = Math.max(1, Math.min(64, Math.floor(this.config.batchSize || 16)));
    for (let offset = 0; offset < pending.length; offset += batchSize) {
      if (signal?.aborted) throw new MemoryError('CANCELLED', '嵌入已取消。');
      const batch = pending.slice(offset, offset + batchSize);
      const vectors = await this.#request(batch.map(item => item.text), task, signal);
      for (let i = 0; i < batch.length; i++) {
        output[batch[i].index] = [...vectors[i]];
        this.cache.set(batch[i].key, vectors[i]);
        while (this.cache.size > (this.config.cacheSize || 2000)) this.cache.delete(this.cache.keys().next().value);
      }
    }
    return output;
  }

  async #request(texts, task, signal) {
    const apiKey = keyFromEnvironment(this.config.apiKeyEnv || 'GOOGLE_API_KEY');
    const model = String(this.config.model).replace(/^models\//, '');
    if (!/^[A-Za-z0-9._-]+$/.test(model)) throw new MemoryError('PROVIDER_CONFIG', '嵌入模型名称包含非法字符。');
    const taskType = task === 'query' ? (this.config.queryTaskType || 'RETRIEVAL_QUERY') : (this.config.documentTaskType || 'RETRIEVAL_DOCUMENT');
    let url, body, headers;
    if (this.protocol === 'google') {
      const base = endpoint(this.config.endpoint || 'https://generativelanguage.googleapis.com/v1beta');
      url = `${base}/models/${encodeURIComponent(model)}:batchEmbedContents`;
      body = { requests: texts.map(text => ({ model: `models/${model}`, content: { parts: [{ text }] }, taskType, outputDimensionality: this.config.dimensions })) };
      headers = { 'x-goog-api-key': apiKey };
    } else {
      const base = endpoint(this.config.endpoint);
      url = base.endsWith('/embeddings') ? base : `${base.endsWith('/v1') ? base : `${base}/v1`}/embeddings`;
      body = { model, input: texts, dimensions: this.config.dimensions };
      // Gateways differ: this optional field is sent only when explicitly configured.
      if (this.config.taskTypeField) body[this.config.taskTypeField] = taskType;
      headers = { authorization: `Bearer ${apiKey}` };
    }
    this.requests++;
    try {
      const payload = await jsonRequest(url, body, headers, { signal, timeoutMs: this.config.timeoutMs || 120000 });
      let rows;
      if (this.protocol === 'google') {
        if (!Array.isArray(payload.embeddings) || payload.embeddings.length !== texts.length) throw new MemoryError('EMBEDDING_RESPONSE', 'Google 嵌入返回条数不符。');
        rows = payload.embeddings.map(item => item.values);
      } else {
        if (!Array.isArray(payload.data) || payload.data.length !== texts.length) throw new MemoryError('EMBEDDING_RESPONSE', '嵌入网关返回条数不符。');
        rows = new Array(texts.length);
        const seen = new Set();
        for (const item of payload.data) {
          if (!Number.isInteger(item.index) || item.index < 0 || item.index >= texts.length || seen.has(item.index)) throw new MemoryError('EMBEDDING_RESPONSE', '嵌入网关返回了重复或无效的 index。');
          seen.add(item.index); rows[item.index] = item.embedding;
        }
      }
      return rows.map(row => normalizeVector(row, this.config.dimensions, this.config.normalization !== 'none'));
    } catch (error) { this.errors++; throw error; }
  }

  health() { return { configured: this.configured, requests: this.requests, errors: this.errors, cached: this.cache.size, ...this.signature() }; }
}

/** OpenAI-compatible non-streaming generation. It never exposes or executes tools. */
export class ChatProvider {
  constructor(config) { this.config = config.chat || config; this.requests = 0; this.errors = 0; }
  get configured() { return Boolean(this.config.model && this.config.endpoint && (this.config.allowAnonymous || process.env[this.config.apiKeyEnv || 'OPENAI_API_KEY'])); }

  async generate({ system, user, maxTokens = 2400, signal }) {
    if (!this.configured) throw new MemoryError('PROVIDER_NOT_CONFIGURED', '后台日记模型尚未配置。');
    if (typeof system !== 'string' || typeof user !== 'string' || !Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 32768) throw new MemoryError('MODEL_INPUT', '模型输入或输出预算无效。');
    const base = endpoint(this.config.endpoint);
    const url = base.endsWith('/chat/completions') ? base : `${base.endsWith('/v1') ? base : `${base}/v1`}/chat/completions`;
    const apiKey = keyFromEnvironment(this.config.apiKeyEnv || 'OPENAI_API_KEY', this.config.allowAnonymous === true);
    const headers = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
    const body = {
      model: this.config.model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      stream: false, temperature: this.config.temperature ?? 0.3,
      [this.config.maxTokenField === 'max_completion_tokens' ? 'max_completion_tokens' : 'max_tokens']: maxTokens,
    };
    this.requests++;
    try {
      const payload = await jsonRequest(url, body, headers, { signal, timeoutMs: this.config.timeoutMs || 120000, maxResponseBytes: this.config.maxResponseBytes || 1048576 });
      const choice = payload.choices?.[0];
      if (!choice || choice.message?.tool_calls?.length) throw new MemoryError('MODEL_OUTPUT', '后台模型未返回普通文字；工具调用不会被执行。', { dispatched: true });
      const content = choice.message?.content;
      const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(part => part.type === 'text').map(part => part.text || '').join('') : '';
      if (!text.trim()) throw new MemoryError('MODEL_OUTPUT', '后台模型返回空内容或拒绝结果。', { dispatched: true });
      const numeric = value => Number.isFinite(value) && value >= 0 ? Math.ceil(value) : null;
      return {
        text, finish_reason: choice.finish_reason || 'unknown', truncated: choice.finish_reason === 'length',
        request_id: typeof payload.id === 'string' ? payload.id.slice(0, 256) : null,
        usage: { input_tokens: numeric(payload.usage?.prompt_tokens), output_tokens: numeric(payload.usage?.completion_tokens), total_tokens: numeric(payload.usage?.total_tokens) },
      };
    } catch (error) { this.errors++; throw error; }
  }

  health() { return { configured: this.configured, model: this.config.model || '', requests: this.requests, errors: this.errors }; }
}
