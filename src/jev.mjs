import { createJudge, applyVerdicts } from '../vendor/vcprag/relevance-judge.js';
import { MemoryError } from './common.mjs';
import { secretValue } from './secrets.mjs';

/** Reuse dsh-vcprag's per-document noul judge; no traditional rerank endpoint. */
export async function judgeWithJev(query, candidates, notes, options, config, { signal, omega = null } = {}) {
  const key = secretValue(config.apiKeyEnv);
  if (!config.endpoint || !config.model || !key) throw new MemoryError('JEV_NOT_CONFIGURED', '::Jev 需要配置 jev.endpoint、jev.model 和对应 apiKeyEnv 环境变量。');
  const prompt = options.preset ? config.prompts?.[options.preset] : config.prompt;
  if (options.preset && !prompt) throw new MemoryError('JEV_PRESET_MISSING', `::Jev${options.preset} 未配置对应 prompts 预设。`);
  const total = AbortSignal.timeout(config.timeoutMs);
  const combined = signal ? AbortSignal.any([signal, total]) : total;
  const transport = async (state, questions) => {
    combined.throwIfAborted();
    if (prompt) questions = { verdict: { type: 'noul', instructions: prompt } };
    const response = await fetch(config.endpoint, {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: config.model, state, questions }), signal: combined,
    });
    if (!response.ok) { await response.body?.cancel(); throw new MemoryError(`JEV_HTTP_${response.status}`, `JEV HTTP ${response.status}`); }
    const reader = response.body.getReader(); let length = 0; const chunks = [];
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        length += value.length;
        if (length > 1048576) throw new MemoryError('JEV_RESPONSE_LIMIT', 'JEV response exceeds 1 MiB');
        chunks.push(Buffer.from(value));
      }
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    finally { reader.releaseLock(); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  };
  const judge = createJudge({ ...config, enabled: true, transport });
  const hits = candidates.map(hit => ({ ...hit, chunkId: hit.note_id, text: notes.get(hit.note_id)?.body || '', title: notes.get(hit.note_id)?.tags?.join(' ') || '' }));
  const result = await judge.judge(query, hits);
  signal?.throwIfAborted();
  if (!result.applied) return { candidates, diagnostics: { applied: false, reason: result.reason, judged: result.judged || 0 } };
  const verdict = applyVerdicts(hits, result.scores, { threshold: config.threshold, k: hits.length });
  let ranked = verdict.out;
  let alpha = options.alpha;
  let fusionScores = null;
  if (options.plus) {
    // VCP's + syntax uses weighted reciprocal-rank fusion. Bare + derives
    // the external weight from native Omega; unavailable Omega means 0.5.
    if (options.autoAlpha) alpha = Number.isFinite(omega) && omega >= 0 && omega <= 1
      ? 1 - Math.max(0.3, Math.min(0.7, 0.5 + 0.8 * (omega - 0.65))) : 0.5;
    const allowed = new Set(ranked.map(hit => hit.note_id));
    const scores = new Map();
    for (const [list, weight] of [[hits.filter(hit => allowed.has(hit.note_id)), 1 - alpha], [ranked, alpha]]) {
      list.forEach((hit, i) => scores.set(hit.note_id, (scores.get(hit.note_id) || 0) + weight / (60 + i + 1)));
    }
    ranked = ranked.slice().sort((a, b) => scores.get(b.note_id) - scores.get(a.note_id));
    fusionScores = scores;
  }
  return { candidates: ranked.map(({ chunkId, text, title, ...hit }) => ({ ...hit,
      score: fusionScores?.get(hit.note_id) ?? result.scores.get(hit.note_id) ?? hit.score,
      reason: `${hit.reason};jev${options.plus ? '-rrf' : ''}` })),
    diagnostics: { applied: true, judged: result.judged, failed: result.failed, dropped: verdict.dropped, unknown: verdict.unknown,
      threshold: config.threshold, alpha, latencyMs: result.latencyMs, source: 'dsh-vcprag-single-candidate-noul' } };
}
