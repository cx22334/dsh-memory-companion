import { createRequire } from 'node:module';
import { BM25 } from '../vendor/vcprag/bm25.js';
import { tokenize } from '../vendor/vcprag/tokenize.js';
import { MemoryError, hash } from './common.mjs';
import { resolveBooks, selectionFor, matchesSelection, roleValveAllows } from './vcp-dsl.mjs';
import { judgeWithJev } from './jev.mjs';
const require = createRequire(import.meta.url);
const words = text => tokenize(String(text || ''), null, { mode: 'gram' });
const finiteVector = v => Array.isArray(v) && v.length > 0 && v.every(Number.isFinite);
const cosine = (a, b) => {
  if (!finiteVector(a) || !finiteVector(b) || a.length !== b.length) return 0;
  const norm = Math.hypot(...a) * Math.hypot(...b);
  return norm ? a.reduce((n, x, i) => n + x * b[i], 0) / norm : 0;
};
function average(vectors, weights) {
  const length = vectors.find(finiteVector)?.length; if (!length) return null;
  const out = new Array(length).fill(0); let sum = 0;
  vectors.forEach((v, i) => { if (finiteVector(v) && v.length === length) { sum += weights[i]; v.forEach((n, j) => out[j] += n * weights[i]); } });
  return sum > 0 ? out.map(n => n / sum) : null;
}
const stamp = note => Date.parse(note.source_time || note.created_at || '') || 0;
const newest = (a, b) => stamp(b) - stamp(a) || a.note_id.localeCompare(b.note_id);
const hitFor = (note, score, reason, source = 'rag') => ({ note_id: note.note_id, revision_id: note.revision_id, score, reason, source });

export class VcpRetrieval {
  constructor(config, { vault, index }) { this.config = config; this.vault = vault; this.index = index; this.vectors = new Map(); this.timeParser = null; }

  async embed(text, signal, task = 'query') {
    signal?.throwIfAborted();
    const key = hash([task, text]);
    if (this.vectors.has(key)) return this.vectors.get(key);
    const result = await this.index.embedding.embed(String(text), { task, signal });
    if (!finiteVector(result)) throw new MemoryError('EMBEDDING_INVALID', 'Invalid DSL query vector');
    this.vectors.set(key, result);
    while (this.vectors.size > 256) this.vectors.delete(this.vectors.keys().next().value);
    return result;
  }

  async events(context, binding) {
    const result = [];
    for (const ref of context.slice(-8)) {
      const event = ref?.event_id ? await this.vault.getEvent(ref.event_id) : null;
      if (!event || !this.vault.canReadEvent(event, binding) || event.source?.session_id !== binding.session_id || event.branch_id !== binding.branch_id || !['user_input', 'assistant_output'].includes(event.origin)) continue;
      result.push(event);
    }
    return result;
  }

  lexical(notes, query, mode, limit) {
    const bm = new BM25(1.5, 0.75, 0.15).build(notes.map(note => ({ chunkId: note.note_id,
      text: mode === 'tag' ? (note.tags || []).join(' ') : note.body, tags: [], date: note.source_time })), words);
    const map = new Map(notes.map(note => [note.note_id, note]));
    return bm.search(words(query), limit).map(hit => hitFor(map.get(hit.chunkId), hit.score, `vcp-bm25-${mode}`));
  }

  async queryControls(query, events, options, signal) {
    const deadline = AbortSignal.timeout(this.config.recall.timeoutMs);
    const active = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const lastAi = events.findLast(event => event.speaker === 'assistant')?.text || '';
    const [u, a] = await Promise.all([this.embed(query, active), lastAi ? this.embed(lastAi.slice(-3000), active) : null]);
    let queryVector = average([u, a], this.config.vcpDsl.mainSearchWeights) || u;
    const anchors = new Map();
    // Exact VCP anchor spellings; hints steer retrieval, never establish facts.
    for (const m of lastAi.matchAll(/(?:\[@(!)?([^\]】]+)\]|【@(!)?([^\]】]+)】)/g)) {
      const name = (m[2] ?? m[4]).trim();
      if (!name || [...name].length > 25 || ['tag', 'tag名称'].includes(name)) continue;
      anchors.set(name, { name, isCore: !!(m[1] || m[3]) || !!anchors.get(name)?.isCore });
      if (anchors.size >= 32) break;
    }
    const ghostTags = [];
    for (const anchor of anchors.values()) ghostTags.push({ ...anchor, vector: await this.embed(anchor.name, active, 'document') });
    const history = [];
    for (const event of events.filter(x => !x.snapshot_id && x.evidence_eligible).slice(-this.config.vcpDsl.historySegmentLimit || events.length)) {
      if (this.config.vcpDsl.historySegmentLimit === 0) break;
      history.push(await this.embed(event.text.slice(-1200), active));
    }
    let activated = [];
    if (options.group) {
      // Reuse upstream matching/activation and vector-fusion methods without its
      // self-starting filesystem watcher or automatic learning writes.
      const Manager = require('../vendor/vcp/dsl/SemanticGroupManager.js');
      const manager = Object.create(Manager.prototype);
      manager.groups = structuredClone(this.config.vcpDsl.semanticGroups?.groups || {});
      manager.groupVectorCache = new Map();
      const groups = manager.detectAndActivateGroups(query);
      for (const [name, data] of groups) {
        const groupText = data.allWords.join(' ');
        manager.groupVectorCache.set(name, await this.embed(groupText, active, 'document'));
      }
      activated = [...groups.keys()];
      queryVector = await manager.getEnhancedVector(query, groups, queryVector);
    }
    return { queryVector, ghostTags, coreTags: ghostTags.filter(t => t.isCore).map(t => t.name),
      supplementalVectors: history.map((vector, i) => ({ vector, weight: this.config.vcpDsl.historyDecay ** (history.length - i) })), activated };
  }

  ranges(query) {
    if (!this.timeParser) { const Parser = require('../vendor/vcp/dsl/TimeExpressionParser.js'); this.timeParser = new Parser(this.config.vcpDsl.locale || 'zh-CN', this.config.timezone); }
    return this.timeParser.parse(query).map(range => ({ start: new Date(range.start).getTime(), end: new Date(range.end).getTime() }));
  }

  async search({ binding, query, fallbackQuery, context, plans, messageCounts, signal, explicit }) {
    if (!plans?.length) return this.index.search(fallbackQuery, binding, { signal, explicit });
    const all = await this.vault.listNotes({ context_id: binding.context_id });
    const eligible = all.filter(note => this.vault.isEligible(note, binding, { explicit }));
    const events = await this.events(context, binding);
    const diagnostics = [], ordered = [], fullIds = new Set(); let maxNotes = 0;
    for (const plan of plans) {
      signal?.throwIfAborted();
      const books = resolveBooks(plan, binding, this.config); // fail closed before any model request
      const selection = selectionFor(books), notes = eligible.filter(note => matchesSelection(note, selection));
      const noteMap = new Map(notes.map(note => [note.note_id, note]));
      const options = plan.options, detail = { placeholder: plan.placeholder, mode: plan.mode };
      diagnostics.push(detail);
      if (!roleValveAllows(options.valve, messageCounts)) { detail.skipped = 'role_valve'; continue; }
      const k = Math.min(this.config.vcpDsl.maxK, Math.max(1, Math.round(this.config.vcpDsl.defaultK * options.multiplier)));
      const full = plan.mode === 'full' || plan.mode === 'gated_full';
      let controls = null;
      if (plan.mode.startsWith('gated')) {
        controls = await this.queryControls(query, events, options, signal);
        const themes = [];
        for (const book of books) {
          const tags = Array.isArray(book.tags) ? book.tags : [];
          const parts = [{ text: book.name, weight: 1 }, ...tags.map(t => {
            const [text, suffix] = String(t).split(':'); const weight = suffix === undefined ? 1 : Number(suffix);
            return { text, weight: Number.isFinite(weight) && weight >= 0 ? weight : 1 };
          })];
          const vectors = [];
          for (const part of parts) vectors.push(await this.embed(part.text, signal, 'document'));
          themes.push(average(vectors, parts.map(p => p.weight)));
        }
        const theme = average(themes, themes.map(() => 1));
        const score = cosine(controls.queryVector, theme);
        const threshold = books.reduce((sum, book) => sum + (book.threshold ?? this.config.vcpDsl.defaultThreshold), 0) / books.length;
        detail.gate = { score, threshold };
        if (score < threshold) { detail.skipped = 'similarity_gate'; continue; }
      }
      let candidates;
      if (full) {
        let chosen = notes.slice().sort(newest);
        if (options.bm25) {
          const ranked = this.lexical(chosen, query, options.bm25.mode, Math.max(1, chosen.length));
          chosen = ranked.map(hit => noteMap.get(hit.note_id));
        }
        if (options.random) chosen.sort((a, b) => hash([binding.session_id, query, plan.placeholder, a.note_id]).localeCompare(hash([binding.session_id, query, plan.placeholder, b.note_id])));
        if (options.last || options.random) chosen = chosen.slice(0, options.last || options.random);
        chosen.forEach(note => fullIds.add(note.note_id));
        candidates = chosen.map((note, i) => hitFor(note, 1 / (i + 1), 'vcp-full-document'));
        detail.engine = 'file-fulltext'; maxNotes += chosen.length;
      } else {
        let ranges = [], timeHits = [];
        if (options.time !== null) {
          ranges = this.ranges(query);
          timeHits = notes.filter(note => ranges.some(range => stamp(note) >= range.start && stamp(note) <= range.end)).sort(newest)
            .slice(0, 50).map((note, i) => hitFor(note, 1 / (i + 1), 'vcp-time', 'time'));
          detail.time = { ranges, ratio: options.time, count: timeHits.length };
        }
        const sparseHits = options.bm25 ? this.lexical(notes, query, options.bm25.mode, this.config.recall.candidateLimit) : [];
        try { controls ||= await this.queryControls(query, events, options, signal); }
        catch (error) { signal?.throwIfAborted(); detail.query_degraded = error.code || error.name; }
        const result = await this.index.search(fallbackQuery, binding, { signal, explicit, selection,
          ...controls, sparseHits, timeHits, bm25Weight: options.bm25?.weight ?? 0.6 });
        detail.engine = result.engine; detail.index = result.diagnostics; detail.activated_groups = controls?.activated || [];
        candidates = result.candidates.map(hit => ({ ...hit, source: hit.source || 'rag' }));
        // Keep explicit time candidates even when native/embedding is unavailable.
        const ids = new Set(timeHits.map(hit => hit.note_id));
        candidates = [...candidates.filter(hit => !ids.has(hit.note_id)), ...timeHits];
        if (options.decay) {
          const { halfLife, minScore, targets } = options.decay;
          candidates = candidates.map(hit => {
            if (hit.source === 'time') return hit;
            const note = noteMap.get(hit.note_id);
            if (targets.length && !targets.some(t => (note?.tags || []).some(tag => tag.toLowerCase().includes(t.toLowerCase())))) return hit;
            const days = Math.max(0, (Date.now() - stamp(note)) / 86400000);
            return { ...hit, score: hit.score * 2 ** (-days / halfLife), reason: `${hit.reason};time-decay` };
          }).filter(hit => hit.source === 'time' || hit.score >= minScore).sort((a, b) => b.score - a.score);
        }
        if (options.jev && candidates.length) {
          // Re-read each candidate before sending its body to an external judge.
          const current = new Map();
          for (const hit of candidates) {
            const note = await this.vault.getNote(hit.note_id);
            if (note?.revision_id === hit.revision_id && this.vault.isEligible(note, binding, { explicit })) current.set(note.note_id, note);
          }
          candidates = candidates.filter(hit => current.has(hit.note_id));
          const judged = await judgeWithJev(query, candidates, current, options.jev, this.config.jev, { signal, omega: result.diagnostics?.omega });
          candidates = judged.candidates; detail.jev = judged.diagnostics;
        }
        if (options.time !== null && ranges.length) {
          const timeK = Math.max(1, Math.round(k * options.time)), semanticK = Math.max(1, k - timeK);
          candidates = [...candidates.filter(hit => hit.source !== 'time').slice(0, semanticK), ...candidates.filter(hit => hit.source === 'time').slice(0, timeK)];
        } else candidates = candidates.slice(0, k);
        if (options.associate && controls) {
          const initial = new Set(candidates.map(hit => hit.note_id)), found = new Map();
          for (const seed of candidates.slice(0, this.config.vcpDsl.associateMaxSeeds || 6)) {
            const note = noteMap.get(seed.note_id); if (!note) continue;
            const related = await this.index.search(note.body, binding, { signal, explicit, selection, limit: k });
            if (!String(related.engine).startsWith('tagmemo-native')) { detail.associate_degraded = related.engine; continue; }
            for (const hit of related.candidates) {
              if (initial.has(hit.note_id)) continue;
              const existing = found.get(hit.note_id) || { hit, seeds: new Set() };
              existing.seeds.add(seed.note_id); if (hit.score > existing.hit.score) existing.hit = hit;
              found.set(hit.note_id, existing);
            }
          }
          candidates.push(...[...found.values()].filter(x => x.seeds.size >= 2).sort((a, b) => b.seeds.size - a.seeds.size || b.hit.score - a.hit.score)
            .slice(0, k).map(x => ({ ...x.hit, reason: `${x.hit.reason};associate:${x.seeds.size}` })));
        }
        if (options.truncate) candidates = candidates.filter(hit => hit.score >= options.truncate);
        // Each indexed note is already a full source file: Expand is idempotent.
        if (options.expand) detail.expand = 'already_full_note';
        maxNotes += Math.max(k, candidates.length);
      }
      detail.returned = candidates.length;
      // Scores from different modes are not calibrated. Preserve declaration
      // order, then within-book order; Recall still admits whole correction groups.
      for (const hit of candidates) if (!ordered.some(row => row.note_id === hit.note_id)) ordered.push(hit);
    }
    return { candidates: ordered.map((hit, i) => ({ ...hit, score: 1 / (i + 1) })), engine: 'vcp-dsl',
      diagnostics: { declarations: diagnostics }, fullNoteIds: [...fullIds], maxNotes: Math.max(1, maxNotes) };
  }
}
