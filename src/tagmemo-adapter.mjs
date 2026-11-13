import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { MemoryError, hash, readJSON, writeJSONAtomic } from './common.mjs';

const require = createRequire(import.meta.url);
const UPSTREAM = '73fd165d858d64d6c849533b3ec8e01c34f69e12';
const ENGINE = `tagmemo-native-${UPSTREAM.slice(0, 12)}`;
const json = value => typeof value === 'string' ? JSON.parse(value) : value;
const abort = signal => {
  if (signal?.aborted) throw new MemoryError('RECALL_ABORTED', 'TagMemo operation was cancelled.');
};
const fail = (code, message, error) => new MemoryError(code, message, {
  engine: ENGINE, upstream: UPSTREAM,
  cause: error ? String(error.message || error) : undefined,
});

function vector(value, dimension, label) {
  if (!value || value.length !== dimension || !Array.from(value).every(Number.isFinite)) {
    throw fail('TAGMEMO_VECTOR_INVALID', `${label} has an invalid vector or dimension.`);
  }
  return value instanceof Float32Array ? value : new Float32Array(value);
}

function flatten(vectors, dimension) {
  const values = new Float32Array(vectors.length * dimension);
  vectors.forEach((item, index) => values.set(item, index * dimension));
  return values;
}

/**
 * Genuine VCP MemoRuntime domain. The caller MUST pass a complete, already
 * authorized domain; all statistics, geometry and propagation are built here.
 * Native SQL, vector tables and manifests are disposable derived assets.
 */
export async function createTagMemoDomain({
  directory, notes, noteVectors, tagEntries = [], tagVectors = [],
  config, scopeHash, fingerprint, signal,
}) {
  abort(signal);
  const dimension = Number(config?.google?.dimensions);
  if (!Number.isSafeInteger(dimension) || dimension < 1 || dimension > 32768) {
    throw fail('TAGMEMO_DIMENSION_INVALID', 'TagMemo requires the configured Google embedding dimension.');
  }
  if (!Array.isArray(notes) || notes.length !== noteVectors?.length
      || tagEntries.length !== tagVectors.length || !scopeHash || !fingerprint) {
    throw fail('TAGMEMO_DOMAIN_INVALID', 'TagMemo requires aligned domain notes, tags, vectors and identity.');
  }
  const noteVectorRows = noteVectors.map((item, index) => vector(item, dimension, `Note ${index}`));
  const tagVectorByName = new Map();
  tagEntries.forEach((entry, index) => {
    const name = String(entry.name || '').trim();
    if (!name || tagVectorByName.has(name)) throw fail('TAGMEMO_TAG_INVALID', 'Tag names must be unique and nonempty.');
    tagVectorByName.set(name, vector(tagVectors[index], dimension, `Tag ${index}`));
  });

  // Never reuse an asset across ACL membership, source revisions, model, or ABI.
  const modelSig = hash(`${config.google.model}:${dimension}`).slice(0, 16);
  const generation = hash({ upstream: UPSTREAM, scopeHash, fingerprint, modelSig });
  const storePath = path.join(path.resolve(directory), `tagmemo-${generation}`);
  const dbPath = path.join(storePath, 'knowledge_base.sqlite');
  await mkdir(storePath, { recursive: true });

  let VexusIndex, NativeKnowledgeRuntime, TagMemoEngine, TagMemoV10Engine, RiverMemoEngine;
  try {
    ({ VexusIndex, NativeKnowledgeRuntime } = require('../vendor/vcp/rust-vexus-lite/index.js'));
    TagMemoEngine = require('../vendor/vcp/TagMemoEngine.js');
    TagMemoV10Engine = require('../vendor/vcp/TagMemoV10Engine.js');
    RiverMemoEngine = require('../vendor/vcp/RiverMemoEngine.js');
  } catch (error) {
    throw fail('TAGMEMO_NATIVE_UNAVAILABLE', 'The pinned VCP native MemoRuntime could not be loaded.', error);
  }

  let runtime, tagIndex, v9, v10, river, artifact;
  let closed = false;
  let closing = false;
  let pending = Promise.resolve();
  let lastQuery = null;
  const rowsByPath = new Map();
  const nativeToNote = new Map();
  const diaryIndices = new Map();
  const nativeRows = [];

  const runSerial = operation => {
    if (closing || closed) return Promise.reject(fail('TAGMEMO_CLOSED', 'TagMemo domain is closed.'));
    const result = pending.then(operation);
    pending = result.catch(() => {});
    return result;
  };

  try {
    notes.forEach((note, index) => {
      if (!note?.note_id || !note?.revision_id || typeof note.body !== 'string') {
        throw fail('TAGMEMO_NOTE_INVALID', 'Every indexed note needs its identity, revision and body.');
      }
      const sourcePath = `entries/${hash(note.note_id)}.md`;
      if (rowsByPath.has(sourcePath)) throw fail('TAGMEMO_DUPLICATE_NOTE', 'An ACL domain may contain only one current revision per note.');
      const tags = [...new Set((note.tags || []).map(item => String(item).trim()).filter(Boolean))];
      if (tags.length > 256 || tags.some(name => !tagVectorByName.has(name))) {
        throw fail('TAGMEMO_TAG_VECTOR_MISSING', 'A note has missing tag embeddings or exceeds the per-note tag bound.');
      }
      const diaryName = `role_${hash([note.context_id, note.owner_role_id, note.author_role_id]).slice(0, 24)}`;
      const row = {
        note_id: note.note_id, revision_id: note.revision_id,
        body: note.body, tags, path: sourcePath, diaryName,
        vector: noteVectorRows[index],
        mtime: Math.max(0, Date.parse(note.source_time || note.created_at || '') || 0),
      };
      rowsByPath.set(sourcePath, row);
      nativeRows.push(row);
    });

    tagIndex = new VexusIndex(dimension, Math.max(64, tagEntries.length + 16));
    runtime = new NativeKnowledgeRuntime(tagIndex);
    const capabilities = runtime.capabilities();
    const required = ['sqlite.ingestion-commit.v1', 'index.tdb-vec.v1', 'memo.native-artifact.v1', 'river.native-query.v1'];
    if (capabilities.abiVersion !== 2 || required.some(value => !capabilities.capabilities?.includes(value))) {
      throw fail('TAGMEMO_ABI_MISMATCH', 'The native binary does not expose the pinned MemoRuntime contract.');
    }
    runtime.openAndInitStore(dbPath, JSON.stringify({
      schemaVersion: 2, readPoolSize: 2, mmapSize: 16 * 1024 * 1024, busyTimeoutMs: 5000,
    }));
    const globalRestore = json(await runtime.restoreGlobalTagIndex(
      dbPath, path.join(storePath, 'index_global_tags_a.vec'), modelSig,
      Math.max(64, tagEntries.length + 16),
    ));
    if (globalRestore?.restored !== true) throw fail('TAGMEMO_RESTORE_FAILED', 'Native tag index restore did not publish a ready index.');
    abort(signal);

    const diaryNames = [...new Set(nativeRows.map(row => row.diaryName))].sort();
    for (const name of diaryNames) {
      const capacity = Math.max(64, nativeRows.filter(row => row.diaryName === name).length + 16);
      const index = new VexusIndex(dimension, capacity);
      const receipt = json(await runtime.restoreDiaryIndex(
        dbPath, name, path.join(storePath, `index_${name}_a.vec`), modelSig, capacity, index,
      ));
      if (receipt?.restored !== true) throw fail('TAGMEMO_RESTORE_FAILED', 'Native diary index restore failed.');
      runtime.registerDiaryIndex(name, index);
      diaryIndices.set(name, index);
      abort(signal);
    }

    const manifestPath = path.join(storePath, 'domain.json');
    const manifest = await readJSON(manifestPath, null);
    if (manifest?.generation !== generation || manifest?.complete !== true) {
      // Batches have compact tag slots, never the whole domain's tag buffer.
      const batchSize = Math.max(1, Math.min(32, Math.floor((64 * 1024 * 1024) / (dimension * 257))));
      for (let offset = 0; offset < nativeRows.length; offset += batchSize) {
        abort(signal);
        const batch = nativeRows.slice(offset, offset + batchSize);
        const probes = json(await runtime.probeIngestionFiles(dbPath, batch.map(row => row.path)));
        const versions = new Map(probes.map(item => [item.path, item.version]));
        const batchTags = [], chunkRows = [], files = [], batchTagVectors = [];
        const tagSlots = new Map();
        for (const row of batch) {
          const tagStart = batchTags.length;
          row.tags.forEach((name, position) => {
            if (!tagSlots.has(name)) {
              tagSlots.set(name, batchTagVectors.length);
              batchTagVectors.push(tagVectorByName.get(name));
            }
            batchTags.push({ name, position: position + 1, vectorSlot: tagSlots.get(name) });
          });
          const chunkStart = chunkRows.length;
          chunkRows.push({ content: row.body, chunkIndex: 0, vectorSlot: chunkStart });
          files.push({
            path: row.path, diaryName: row.diaryName, checksum: hash(row.body),
            mtime: row.mtime, expectedVersion: versions.get(row.path) || 0,
            size: Buffer.byteLength(row.body, 'utf8'), chunkStart, chunkCount: 1,
            tagStart, tagCount: row.tags.length, tagsOnly: false,
            migrationCacheId: null, migrationSourceFileId: null,
          });
        }
        const plan = {
          operationId: randomUUID(), batchId: randomUUID(), dimension, modelSig,
          createdAt: Date.now(), expiresAt: Date.now() + 30 * 60 * 1000,
          files, chunks: chunkRows, tags: batchTags,
        };
        const receipt = json(await runtime.commitIngestionBatch(dbPath, JSON.stringify(plan),
          flatten(batch.map(row => row.vector), dimension), flatten(batchTagVectors, dimension)));
        if (receipt?.indexReady !== true) throw fail('TAGMEMO_INGESTION_NOT_READY', 'Native ingestion has not published all domain indices.');
      }
    }

    // Hydrated native IDs map to immutable logical revisions; never trust IDs
    // from another generation or a caller-controlled file path.
    for (let offset = 0; offset < nativeRows.length; offset += 128) {
      const hydrated = json(await runtime.hydrateChunksByFilePaths(dbPath,
        nativeRows.slice(offset, offset + 128).map(row => row.path)));
      for (const row of hydrated) {
        const note = rowsByPath.get(row.sourceFile);
        if (!note || row.text !== note.body || !Number.isSafeInteger(row.id)) {
          throw fail('TAGMEMO_HYDRATION_MISMATCH', 'Native source hydration does not match the authorized note snapshot.');
        }
        // The hydration ABI includes a base64 vector; the runtime already owns
        // it, so do not retain a second complete vector table in JavaScript.
        nativeToNote.set(row.id, { id: row.id, text: row.text,
          sourceFile: row.sourceFile, diaryName: row.diaryName, fileId: row.fileId,
          note_id: note.note_id, revision_id: note.revision_id });
      }
    }
    if (nativeToNote.size !== nativeRows.length) throw fail('TAGMEMO_HYDRATION_INCOMPLETE', 'Native domain does not contain exactly one chunk per current note.');

    const runtimeConfig = { model: config.google.model, dimension };
    const facade = { dbPath, nativeKnowledgeRuntime: runtime, tagMemoV10Engine: null };
    const ragParams = { KnowledgeBaseManager: { riverMemo: config.vcpDsl?.river || {} } };
    v9 = new TagMemoEngine(null, tagIndex, runtimeConfig, ragParams, facade);
    v10 = new TagMemoV10Engine(null, tagIndex, runtimeConfig, ragParams, {
      v9Engine: v9, getNativeRuntime: () => runtime,
    });
    facade.tagMemoV10Engine = v10;
    facade.onNativeMemoArtifactPublished = async result => v10.publishNativeArtifactHandle(result);
    if (!await v9.doMatrixRebuild()) throw fail('TAGMEMO_ARTIFACT_FAILED', 'Native Memo geometry and graph were not published.');
    artifact = v10.getArtifactSnapshot({ buildIfMissing: false });
    if (!artifact?.artifactSig) throw fail('TAGMEMO_ARTIFACT_FAILED', 'Native Memo artifact handle is unavailable.');
    river = new RiverMemoEngine(v10, { config: config.vcpDsl?.river || {} });
    abort(signal);
    await writeJSONAtomic(manifestPath, {
      generation, upstream: UPSTREAM, scopeHash, fingerprint, modelSig,
      notes: nativeRows.length, tags: tagEntries.length, complete: true,
      artifactSig: artifact.artifactSig, disposable: true,
    });
    // Ingestion is complete. Subsequent requests use native-owned vectors.
    noteVectorRows.length = 0;
    tagVectorByName.clear();
    for (const row of nativeRows) delete row.vector;
    rowsByPath.clear();

    return {
      engine: ENGINE,
      search(queryVector, queryText, { limit = 30, signal: querySignal,
        coreTags = [], ghostTags = [], supplementalVectors = [], sparseHits = [], timeHits = [], bm25Weight = 0.6 } = {}) {
        return runSerial(async () => {
          abort(querySignal);
          if (!nativeRows.length) return [];
          const query = vector(queryVector, dimension, 'Query');
          const topK = Math.max(1, Math.min(nativeRows.length, Math.floor(Number(limit) || 30)));
          const candidateK = Math.min(nativeRows.length, Math.max(topK,
            Math.floor(Number(config.recall?.candidateLimit) || 300), 300));
          let observationHandle = null;
          try {
            // All unmentioned fields use the pinned Rust PipelineConfig defaults.
            // KBM's JS production facade selects 0.1 for cross-domain language.
            const raw = await tagIndex.runMemoPipeline(dbPath, artifact.artifactSig,
              JSON.stringify({ queryId: randomUUID(), queryText: String(queryText || ''),
                coreTags, ghostTags,
                config: { langPenaltyCrossDomain: 0.1, ...(config.vcpDsl?.pipeline || {}) } }),
              query, new Float32Array(0));
            const metadata = json(raw?.metadataJson);
            observationHandle = metadata?.observationHandle;
            if (!observationHandle || metadata?.artifactSig !== artifact.artifactSig
                || !(raw.enhancedVector instanceof Float32Array) || raw.enhancedVector.length !== dimension) {
              throw fail('TAGMEMO_PIPELINE_INVALID', 'Native Memo sensing returned an invalid observation.');
            }
            abort(querySignal);
            // The non-deduplicating native ABI preserves different roles' voices.
            // Merge only identical native chunk IDs across original/enhanced ANN.
            const original = json(await runtime.searchDiaryIndices(diaryNames, query, candidateK, candidateK));
            const enhanced = json(await runtime.searchDiaryIndices(diaryNames, raw.enhancedVector, candidateK, candidateK));
            const candidates = new Map();
            for (const item of [...(original.results || []), ...(enhanced.results || [])]) {
              const source = nativeToNote.get(Number(item.id));
              if (!source) throw fail('TAGMEMO_DOMAIN_ESCAPE', 'Native candidate is outside the current source snapshot.');
              const previous = candidates.get(item.id);
              if (!previous || item.score > previous.score) candidates.set(item.id, { ...source, ...item });
            }
            // VCP Shotgun history supplements, bounded to the same ACL/book domain.
            for (const supplement of supplementalVectors) {
              abort(querySignal);
              const extra = json(await runtime.searchDiaryIndices(diaryNames,
                vector(supplement.vector, dimension, 'History'), Math.max(2, Math.round(candidateK / 2)), candidateK));
              for (const item of extra.results || []) {
                const source = nativeToNote.get(Number(item.id)); if (!source) continue;
                const score = item.score * supplement.weight;
                if (!candidates.has(item.id) || score > candidates.get(item.id).score) candidates.set(item.id, { ...source, ...item, score });
              }
            }
            const byNote = new Map([...nativeToNote.values()].map(row => [row.note_id, row]));
            const maxSparse = Math.max(1, ...sparseHits.map(hit => hit.score));
            for (const hit of sparseHits) {
              const source = byNote.get(hit.note_id);
              if (!source || source.revision_id !== hit.revision_id) continue;
              const previous = candidates.get(source.id) || { ...source, score: 0 };
              const sparse = hit.score / maxSparse;
              candidates.set(source.id, { ...previous, bm25Score: sparse,
                hybridScore: (1 - bm25Weight) * previous.score + bm25Weight * sparse,
                score: (1 - bm25Weight) * previous.score + bm25Weight * sparse });
            }
            abort(querySignal);
            const empty = [];
            const prepared = {
              denoisedVector: raw.enhancedVector,
              localVector: new Float32Array(0), transferVector: new Float32Array(0),
              queryState: {
                queryId: metadata.queryId, sourceField: empty, localField: empty, transferField: empty,
                localDomain: { ids: empty }, transferDomain: { ids: empty },
                queryRiverGraph: { nodes: empty, edges: empty },
                sourceObservation: {
                  matchedTags: metadata.matchedTags || [], coreTagsMatched: metadata.coreTagsMatched || [],
                  diagnostics: { completeObservation: true }, fieldProvenance: empty,
                },
              },
            };
            const result = await river.rerank({ text: String(queryText || ''), vector: query },
              [...candidates.values()],
              { diaryNames, allowedFileIds: [...new Set([...nativeToNote.values()].map(row => row.fileId))] },
              { artifact, dbPath, topK, observationHandle, nativePreparedQuery: prepared,
                nativeJointQuery: false, includeTrace: false });
            abort(querySignal);
            lastQuery = { algorithm: result.algorithmVersion, candidates: candidates.size, returned: result.results.length,
              omega: result.omega?.omega ?? null, coreTags: coreTags.length, ghosts: ghostTags.length,
              historyQueries: supplementalVectors.length, sparseCandidates: sparseHits.length, explicitTimeCandidates: timeHits.length };
            return result.results.map(item => {
              const source = nativeToNote.get(Number(item.id));
              if (!source) throw fail('TAGMEMO_DOMAIN_ESCAPE', 'Native readout is outside the current source snapshot.');
              const sources = ['semantic'];
              if (Number(item.graphBonus) > 0 || Number(item.pathBonus) > 0
                  || Number(item.topologyBonus) > 0 || Number(item.anchorBonus) > 0
                  || Number(item.fieldResonanceBonus) > 0) sources.push('association');
              return { note_id: source.note_id, revision_id: source.revision_id,
                score: Number(item.score) || 0,
                reason: `tagmemo:${sources.join('+')}:${result.algorithmVersion}:${item.role || 'thematic_neighbor'}` };
            });
          } catch (error) {
            if (error instanceof MemoryError) throw error;
            throw fail('TAGMEMO_QUERY_FAILED', 'Native TagMemo retrieval failed.', error);
          } finally {
            if (observationHandle) {
              try { tagIndex.releaseMemoObservation(observationHandle); } catch {}
            }
          }
        });
      },
      async close() {
        if (closed || closing) return pending;
        closing = true;
        await pending;
        try { await v9?.shutdown?.(); } finally {
          runtime?.shutdown();
          diaryIndices.clear();
          nativeToNote.clear();
          closed = true;
        }
      },
      health() {
        return { engine: ENGINE, status: closed ? 'closed' : closing ? 'closing' : 'ready',
          upstream: UPSTREAM, scopeHash, fingerprint, dimension,
          notes: nativeRows.length, tags: tagEntries.length,
          storage: 'rebuildable-native-sqlite-and-tdb-vec',
          associationControl: 'native-defaults; select baseline engine to bypass native graph',
          artifact: artifact?.artifactSig, lastQuery,
          cancellation: 'cooperative-between-native-calls',
          native: closed ? null : runtime.stats() };
      },
    };
  } catch (error) {
    try { await v9?.shutdown?.(); } catch {}
    try { runtime?.shutdown(); } catch {}
    if (error instanceof MemoryError) throw error;
    throw fail('TAGMEMO_INITIALIZATION_FAILED', 'Native TagMemo domain initialization failed.', error);
  }
}
