import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { BM25 } from '../vendor/vcprag/bm25.js';
import { tokenize } from '../vendor/vcprag/tokenize.js';
import { MemoryError, canonical, hash, readJSON, writeJSONAtomic, serialQueue } from './common.mjs';

const require = createRequire(import.meta.url);
const words = text => tokenize(text, null, { mode: 'gram' });
const cancelled = signal => { if (signal?.aborted) throw new MemoryError('CANCELLED', 'Memory retrieval cancelled.'); };
const failure = error => ({ code: String(error?.code || error?.name || 'INDEX_UNAVAILABLE') });
const noteText = note => `${(note.tags || []).join(' ')}\n${note.body || ''}`;

/** This identifies the complete readable corpus, not a post-search filter. */
export function bindingScope(binding, explicit = false) {
  return { role_id: binding.role_id, context_id: binding.context_id,
    read_role_ids: [...new Set([binding.role_id, ...(binding.read_role_ids || [])])].sort(),
    read_public: binding.read_public === true, policy_revision: binding.policy_revision,
    epoch: binding.epoch, explicit: explicit === true };
}

function normalized(vector, dimension) {
  if (!Array.isArray(vector) || vector.length !== dimension || vector.some(n => !Number.isFinite(n))) {
    throw new MemoryError('EMBEDDING_DIMENSION', 'Embedding does not match the configured finite vector space.');
  }
  const norm = Math.hypot(...vector);
  if (!(norm > 0)) throw new MemoryError('EMBEDDING_ZERO_VECTOR', 'Embedding returned a zero vector.');
  return vector.map(n => n / norm);
}

/** Await an optional improvement only until the interactive request's deadline. */
function withinDeadline(promise, milliseconds, signal) {
  if (milliseconds <= 0) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); fn(value); };
    const abort = () => finish(reject, new MemoryError('CANCELLED', 'Memory retrieval cancelled.'));
    const timer = setTimeout(() => finish(resolve, undefined), milliseconds);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    promise.then(value => finish(resolve, value), error => finish(reject, error));
  });
}

/**
 * Markdown and control history remain authoritative. Each domain contains only
 * eligible notes before BM25 document frequencies, vector candidates or TagMemo
 * tag geometry are constructed. Neither engine ever sees the global corpus.
 */
export class IndexEngine {
  constructor(config, { vault, embedding }) {
    this.config = config; this.vault = vault; this.embedding = embedding;
    this.directory = path.join(config.vaultPath, '索引');
    this.domains = new Map(); this.bindings = new Map(); this.buildQueue = serialQueue();
    this.vectorCache = new Map(); this.queryCache = new Map(); this.generation = 0;
    this.closed = true; this.stop = new AbortController(); this.tdbClass = null;
    this.tdbError = null; this.lastError = null;
  }

  async open() {
    if (!this.closed) return this;
    this.closed = false; this.stop = new AbortController();
    await fs.mkdir(this.directory, { recursive: true });
    try {
      const module = require('triviumdb');
      if (typeof module.TriviumDB !== 'function') throw new MemoryError('TDB_API_UNAVAILABLE', 'TriviumDB 0.9.0 constructor is unavailable.');
      this.tdbClass = module.TriviumDB; this.tdbError = null;
    } catch (error) { this.tdbError = failure(error); }
    return this;
  }

  _assertBinding(binding) {
    if (this.closed) throw new MemoryError('INDEX_CLOSED', 'The index engine is closed.');
    if (!binding?.binding_id || !binding.role_id || !binding.context_id) throw new MemoryError('UNBOUND_MEMORY', 'Bind a role and context before retrieval.');
    const live = this.vault.getBinding(binding.session_id);
    if (!live || live.binding_id !== binding.binding_id || canonical(bindingScope(live)) !== canonical(bindingScope(binding))) {
      throw new MemoryError('STALE_BINDING', 'The role binding changed; obtain a current binding before retrieval.');
    }
  }

  _embeddingSignature() {
    return typeof this.embedding.signature === 'function' ? this.embedding.signature() :
      { model: this.config.google.model, dimensions: this.config.google.dimensions, endpoint: this.config.google.endpoint };
  }

  async _view(binding, explicit = false) {
    this._assertBinding(binding);
    // listNotes also observes external edits. Filtering precedes all statistics.
    const notes = (await this.vault.listNotes({ context_id: binding.context_id }))
      .filter(note => this.vault.isEligible(note, binding, { explicit }))
      .sort((a, b) => a.note_id.localeCompare(b.note_id));
    this._assertBinding(binding);
    const scopeHash = hash({ acl: bindingScope(binding, explicit), embedding: this._embeddingSignature() });
    const fingerprint = hash({ version: 2, scopeHash, notes: notes.map(note => [note.note_id, note.revision_id,
      note.tags || [], note.body || '', note.kind, note.owner_role_id, note.author_role_id, note.source_time]) });
    return { notes, scopeHash, fingerprint, explicit };
  }

  _domain(view, binding) {
    const key = `${view.scopeHash}:${view.fingerprint}`;
    let domain = this.domains.get(key);
    if (!domain) {
      domain = { ...view, key, binding: structuredClone(binding), map: new Map(view.notes.map(note => [note.note_id, note])),
        directory: path.join(this.directory, 'domains', view.scopeHash, view.fingerprint),
        lexical: new BM25(1.5, 0.75, 0.15).build(view.notes.map(note => ({ chunkId: note.note_id,
          text: noteText(note), tags: note.tags || [], date: note.source_time })), words),
        tdb: null, tagmemo: null, status: view.notes.length ? 'pending' : 'empty', errors: {}, promise: null,
        users: 0, lastUsed: Date.now() };
      this.domains.set(key, domain);
    }
    this.bindings.set(view.scopeHash, { binding: structuredClone(binding), explicit: view.explicit });
    while (this.bindings.size > 128) this.bindings.delete(this.bindings.keys().next().value);
    domain.lastUsed = Date.now();
    return domain;
  }

  async _vectors(texts, signal) {
    const signature = this._embeddingSignature();
    const dimension = this.config.google.dimensions;
    const result = new Array(texts.length), missing = [];
    for (let i = 0; i < texts.length; i++) {
      cancelled(signal);
      const key = hash({ signature, task: 'document', text: texts[i] });
      let vector = this.vectorCache.get(key);
      if (!vector) {
        const cached = await readJSON(path.join(this.directory, 'embeddings', `${key}.json`), null).catch(() => null);
        if (cached?.signature === hash(signature)) {
          try { vector = normalized(cached.vector, dimension); } catch { /* Rebuild a damaged derived cache. */ }
        }
      }
      if (vector) { this.vectorCache.set(key, vector); result[i] = vector; }
      else missing.push({ index: i, key, text: texts[i] });
    }
    // Bound provider batches; partial success is retained if a later batch fails.
    for (let offset = 0; offset < missing.length; offset += 16) {
      cancelled(signal);
      const batch = missing.slice(offset, offset + 16);
      const vectors = await this.embedding.embedMany(batch.map(item => item.text), { task: 'document', signal });
      if (vectors.length !== batch.length) throw new MemoryError('EMBEDDING_COUNT', 'Embedding batch length mismatch.');
      for (let i = 0; i < batch.length; i++) {
        const vector = normalized(vectors[i], dimension), item = batch[i];
        result[item.index] = vector; this.vectorCache.set(item.key, vector);
        await writeJSONAtomic(path.join(this.directory, 'embeddings', `${item.key}.json`), { signature: hash(signature), vector });
      }
    }
    while (this.vectorCache.size > 4096) this.vectorCache.delete(this.vectorCache.keys().next().value);
    return result;
  }

  _startBuild(domain) {
    if (domain.promise || !domain.notes.length || this.closed) return domain.promise || Promise.resolve(domain);
    const generation = this.generation;
    domain.status = 'queued';
    domain.promise = this.buildQueue(async () => {
      if (this.closed || generation !== this.generation) { domain.status = 'retired'; return domain; }
      domain.status = 'building';
      const signal = this.stop.signal;
      try {
        const noteVectors = await this._vectors(domain.notes.map(noteText), signal);
        cancelled(signal);
        if (generation !== this.generation) { domain.status = 'retired'; return domain; }
        // A build that outlived a source/ACL change is never published.
        const current = await this._view(domain.binding, domain.explicit);
        if (current.fingerprint !== domain.fingerprint) { domain.status = 'retired'; return domain; }
        await fs.mkdir(domain.directory, { recursive: true });
        if (this.tdbClass) {
          try {
            const tdb = new this.tdbClass(path.join(domain.directory, 'baseline.tdb'), { dim: this.config.google.dimensions,
              dtype: 'f32', syncMode: 'normal', storageMode: 'mmap', loadTextIndex: true, expectedNodes: domain.notes.length });
            domain.tdb = tdb;
            for (let index = 0; index < domain.notes.length; index++) {
              const note = domain.notes[index];
              tdb.upsertWithId(index + 1, noteVectors[index], { note_id: note.note_id, revision_id: note.revision_id });
            }
            tdb.rebuildTextIndex(domain.notes.map((note, index) => ({ id: index + 1, text: noteText(note), keywords: note.tags || [] })));
            tdb.flush();
          } catch (error) { domain.errors.baseline = failure(error); domain.tdb?.close(); domain.tdb = null; }
        } else domain.errors.baseline = this.tdbError || { code: 'TDB_UNAVAILABLE' };

        // Baseline and current upstream native TagMemo are separate, rebuildable
        // stores. The latter owns its native SQLite metadata and vcp-tdb-index;
        // there is intentionally no JS better-sqlite3 or replacement PPR here.
        try {
          const tagEntries = [...new Set(domain.notes.flatMap(note => note.tags || []))].sort().map((name, index) => ({ id: index + 1, name }));
          const tagVectors = await this._vectors(tagEntries.map(tag => tag.name), signal);
          const { createTagMemoDomain } = await import('./tagmemo-adapter.mjs');
          domain.tagmemo = await createTagMemoDomain({ directory: path.join(domain.directory, 'tagmemo'),
            notes: domain.notes, noteVectors, tagEntries, tagVectors, config: this.config,
            scopeHash: domain.scopeHash, fingerprint: domain.fingerprint, signal });
        } catch (error) { domain.errors.tagmemo = failure(error); }
        if (this.closed || generation !== this.generation) {
          await this._closeDomain(domain); domain.status = 'retired'; return domain;
        }
        domain.status = domain.tagmemo && domain.tdb ? 'ready' : 'degraded';
        await writeJSONAtomic(path.join(domain.directory, 'manifest.json'), { version: 2, scope_hash: domain.scopeHash,
          fingerprint: domain.fingerprint, embedding: this._embeddingSignature(), note_count: domain.notes.length,
          baseline: domain.tdb ? 'triviumdb-0.9.0' : null, tagmemo: domain.tagmemo?.engine || null, errors: domain.errors });
      } catch (error) {
        domain.errors.build = failure(error); domain.status = 'degraded'; this.lastError = failure(error);
      }
      return domain;
    });
    return domain.promise;
  }

  _lexical(domain, query, limit) {
    return domain.lexical.search(words(query), limit).map(hit => ({ note_id: hit.chunkId,
      revision_id: domain.map.get(hit.chunkId).revision_id, score: hit.score, reason: 'bm25' }));
  }

  async _queryVector(query, domain, signal) {
    const key = hash({ scope: domain.scopeHash, signature: this._embeddingSignature(), query });
    if (this.queryCache.has(key)) return this.queryCache.get(key);
    const vector = normalized(await this.embedding.embed(query, { task: 'query', signal }), this.config.google.dimensions);
    this.queryCache.set(key, vector);
    while (this.queryCache.size > 128) this.queryCache.delete(this.queryCache.keys().next().value);
    return vector;
  }

  async search(query, binding, { limit = this.config.recall.candidateLimit, signal, explicit = false } = {}) {
    cancelled(signal); this._assertBinding(binding);
    const text = String(query ?? '').trim();
    const max = Math.max(1, Math.min(Number(limit) || 100, this.config.recall.candidateLimit));
    if (!text) return { candidates: [], engine: 'none', diagnostics: { status: 'empty_query' } };
    const view = await this._view(binding, explicit), domain = this._domain(view, binding);
    const deadline = Date.now() + this.config.recall.timeoutMs;
    let candidates = this._lexical(domain, text, max), engine = 'bm25-degraded';
    this._startBuild(domain);
    if (!domain.notes.length) return { candidates: [], engine: 'none', diagnostics: { status: 'empty_domain', scope_hash: view.scopeHash } };
    // First access can already have reusable embeddings/native files. Never wait
    // indefinitely for provider/network work; subsequent turns use the ready domain.
    domain.users++;
    try {
    await withinDeadline(domain.promise, Math.min(150, Math.max(0, deadline - Date.now())), signal);
    if (domain.tdb || domain.tagmemo) {
      const timeout = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
      const querySignal = signal ? AbortSignal.any([signal, timeout, this.stop.signal]) : AbortSignal.any([timeout, this.stop.signal]);
      try {
        const vector = await this._queryVector(text, domain, querySignal);
        cancelled(signal);
        if (this.config.recall.engine === 'tagmemo' && domain.tagmemo) {
          candidates = await domain.tagmemo.search(vector, text, { limit: max, signal: querySignal });
          engine = domain.tagmemo.engine;
        } else if (domain.tdb) {
          candidates = domain.tdb.searchHybrid(vector, text, max, 0, 0, 0.7).map(hit => ({
            note_id: hit.payload?.note_id, revision_id: hit.payload?.revision_id, score: hit.score, reason: 'tdb-hybrid' }));
          engine = this.config.recall.engine === 'baseline' ? 'tdb-baseline-0.9.0' : 'tdb-baseline-degraded';
        }
      } catch (error) { cancelled(signal); domain.errors.query = failure(error); }
    }
    // Re-check the entire corpus, not only returned hits: a removed private note
    // must not continue affecting another note's rank through old graph statistics.
    const latest = await this._view(binding, explicit);
    if (latest.fingerprint !== domain.fingerprint) {
      const fresh = this._domain(latest, binding); this._startBuild(fresh);
      return { candidates: this._lexical(fresh, text, max), engine: 'bm25-degraded',
        diagnostics: { status: 'domain_changed', scope_hash: latest.scopeHash, fingerprint: latest.fingerprint } };
    }
    const unique = new Map();
    for (const hit of candidates) {
      const note = domain.map.get(hit.note_id);
      if (!note || hit.revision_id !== note.revision_id || !Number.isFinite(hit.score)) continue;
      if (!unique.has(hit.note_id) || hit.score > unique.get(hit.note_id).score) unique.set(hit.note_id, hit);
    }
    return { candidates: [...unique.values()].sort((a, b) => b.score - a.score).slice(0, max), engine,
      diagnostics: { status: domain.status, scope_hash: domain.scopeHash, fingerprint: domain.fingerprint,
        configured_engine: this.config.recall.engine, actual_engine: engine, errors: structuredClone(domain.errors) } };
    } finally { domain.users--; await this._prune(); }
  }

  async rebuild(binding) {
    if (binding) {
      this._assertBinding(binding);
      const view = await this._view(binding), domain = this._domain(view, binding);
      if (domain.status === 'degraded') { await this._closeDomain(domain); domain.promise = null; domain.errors = {}; }
      await this._startBuild(domain);
      await this._prune();
      return { scope_hash: domain.scopeHash, status: domain.status, errors: structuredClone(domain.errors),
        baseline_ready: !!domain.tdb, tagmemo_ready: !!domain.tagmemo };
    }
    const known = [...this.bindings.values()];
    if (!known.length) return { status: 'awaiting_binding', domains: [] };
    const results = [];
    for (const item of known) {
      try { results.push(await this.rebuild(item.binding)); } catch (error) { results.push({ status: 'unavailable', ...failure(error) }); }
    }
    return { status: 'complete', domains: results };
  }

  invalidate() {
    // Existing requests retain their immutable domain until final gates finish.
    // Future queries compute a current corpus fingerprint and cannot use it.
    this.queryCache.clear();
  }

  async _prune() {
    // A diary revision creates a new immutable generation. Retain only a small
    // working set of open native handles; disk assets stay rebuildable caches.
    const idle = [...this.domains.values()].filter(domain => !domain.users &&
      !['queued', 'building'].includes(domain.status)).sort((a, b) => a.lastUsed - b.lastUsed);
    for (const domain of idle) {
      if (this.domains.size <= 8) break;
      if (!this.domains.delete(domain.key)) continue;
      await this._closeDomain(domain);
    }
  }

  async _closeDomain(domain) {
    try { await domain.tagmemo?.close(); } catch (error) { this.lastError = failure(error); }
    try { domain.tdb?.close(); } catch (error) { this.lastError = failure(error); }
    domain.tagmemo = null; domain.tdb = null;
  }

  async close() {
    if (this.closed) return;
    this.closed = true; this.generation++; this.stop.abort();
    await this.buildQueue.drain();
    for (const domain of this.domains.values()) await this._closeDomain(domain);
    this.domains.clear(); this.queryCache.clear(); this.vectorCache.clear();
  }

  health() {
    const rows = [...this.domains.values()];
    return { status: this.closed ? 'closed' : rows.some(row => row.status === 'degraded') ? 'degraded' : 'open',
      configured_engine: this.config.recall.engine, baseline_module: this.tdbClass ? 'triviumdb-0.9.0' : 'unavailable',
      baseline_error: this.tdbError, domains: rows.map(domain => ({ scope_hash: domain.scopeHash,
        fingerprint: domain.fingerprint, status: domain.status, baseline_ready: !!domain.tdb,
        tagmemo_ready: !!domain.tagmemo, tagmemo: domain.tagmemo?.health(), errors: domain.errors })),
      last_error: this.lastError, rebuildable: true };
  }
}
