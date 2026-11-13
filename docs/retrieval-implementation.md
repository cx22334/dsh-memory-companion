# Retrieval implementation and provenance

Implementation status means source code has been connected. At the user's request, this delivery has **not** been installed, compiled, started, tested, typechecked or subjected to validation scripts. Native availability and provider credentials are reported at runtime; a fallback is never reported as successful TagMemo execution.

## Actual engines

- `src/index-engine.mjs` uses the official `triviumdb@0.9.0` API: `TriviumDB(path, options)`, `upsertWithId`, `rebuildTextIndex`, `searchHybrid`, `flush`, and `close`. The reviewed distribution interfaces were supplied in `sources/triviumdb-0.9.0/`. It does not use an imagined 0.8 API or a separately invented TDB lexical-only call.
- `src/tagmemo-adapter.mjs` calls the current upstream native TagMemo pipeline and River readout, fixed at VCPToolBox commit `73fd165d858d64d6c849533b3ec8e01c34f69e12`. See `tagmemo-native.md` and `vendor/vcp/SOURCE.md` for the exact native path, platform assets and upstream licenses.
- `vendor/vcprag/bm25.js` and `tokenize.js` are the MIT-licensed lexical fallback from `dsh-vcprag@afc01ec752c5e33e925939ac740f03c93c132f73`. Gram tokenization deliberately avoids requiring an optional native segmenter.

The npm TDB baseline and VCP native TagMemo have separate derived stores. The latter owns its upstream native metadata store and `vcp-tdb-index` implementation. There is no JavaScript `better-sqlite3` dependency and no private imitation of the TagMemo algorithm.

`engine=tagmemo` selects the actual native pipeline when ready. Unavailable native assets, provider failure, indexing in progress, or an interactive deadline produce explicit `tdb-baseline-degraded` or `bm25-degraded` results. `engine=baseline` selects npm TDB hybrid retrieval when ready. A baseline response is not evidence that native TagMemo succeeded. The native algorithm's association behavior follows upstream; an unrelated Boolean must not be described as disabling every native association stage.

## Corpus and timing contract

Every exact role/context/read-role/public/explicit-read policy forms an isolated readable domain. Current file revisions, control status and source exclusions are applied **before** tokenization, BM25 frequencies, vector insertion, tag asset construction or native graph propagation. The entire corpus fingerprint is checked again after a query, so a deleted note cannot continue changing another result through stale graph statistics.

Native builds are serialized and use immutable corpus generations. A cache of normalized embeddings is keyed by model signature, task and exact text. It is not a searchable store. Interactive requests wait briefly for indexing and apply a bounded query-embedding deadline. A build that outlives a changed corpus is not published. Native synchronous calls themselves cannot be interrupted mid-call by an AbortSignal; cancellation is observed at JS boundaries.

Only eight idle corpus generations retain open native handles. Derived files remain under `索引/`; they are excluded from authority/export and may be rebuilt. This implementation prioritizes immutable, isolated generations over in-place incremental native graph mutation. Large corpora or frequent edits can therefore incur significant rebuild work and disk cache growth; no performance claim has been measured.

## Recall contract

The current host user input leads the query. A bounded suffix is read back from captured original events with matching session, branch, world and ACL. Synthetic injections and compacted-memory strings are not query evidence. No per-turn generation-model planning or reranking is introduced.

`src/recall.mjs` constructs pending correction/retraction components. Each active correcting revision precedes its targets, while dates and ordering never establish truth. A withdrawn correcting note disables its own pending claims; withdrawal does not propagate into its old targets. Confirmed/rejected relations are not pending constraints, and approval effects remain the Vault's responsibility.

An inaccessible, missing, changed or excluded required target prevents that visible correction from being injected alone. The omission contains no target ID, title, tag, date, count or existence hint. Connected pending statements are selected as a whole, including multiple branches and cycles. Groups exceeding the note/token budget are skipped whole; bodies are never truncated through a denial. Locked notes still pass normal injection budgets and eligibility gates.

Quoted support is rechecked against the original event hash and exact UTF-8 byte range. Exact quotation certifies location, not semantic truth. A public summary does not grant access to its private source quote. Snapshots include only admitted items and permitted source metadata; an empty item list has an empty rendered body.

Same-turn snapshots freeze selection while safe. Each reuse rechecks current binding, revisions, source exclusions and complete pending-group membership. A newly added correction invalidates a formerly standalone cached claim. A final state read removes an entire group if it changed during retrieval. Snapshots are synthetic, explicitly ineligible as original evidence.

The host adapter owns cumulative historical-context accounting. Since the inspected DSH context API retains previous injections without a public deletion method, it rejects further steps when the cumulative budget or revocation rules require a fresh clean session. Recall does not silently summarize deleted content or pretend older snapshots have been removed from model context.
