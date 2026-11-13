> Implementation update (2026-11-13): the investigation below records the original local checkout. Its proposed legacy three-JS/SQLite adapter was superseded before implementation. The delivered implementation uses VCPToolBox commit 73fd165d858d64d6c849533b3ec8e01c34f69e12, the real NativeKnowledgeRuntime + TagMemo pipeline + River readout, and npm triviumdb 0.9.0 as a separately selectable baseline. See docs/tagmemo-native.md and docs/retrieval-implementation.md. No tests, startup, typechecks or validation scripts were run.
# 检索复用工作笔记

仅阅读源码；未运行测试、验证脚本、构建、类型检查或试启动，未修改上游。HEAD 仅登记检出版本；源码实际取自当前工作树，不宣称工作树与 HEAD 完全一致。随后用户要求核实最新版浪潮，旧本地算法暂不锁定，等待 root 提供最新上游源码。

## 来源与许可

| 来源 | 检出 HEAD | 文件许可 |
|---|---|---|
| `C:\重构工程\VCPToolBox` | `12910ff3a28811d5c68c390ec5b0d3e6c4d22a4f` / `cat-local-sync` | 根 LICENSE: CC BY-NC-SA 4.0 |
| `C:\重构工程\_refs\memory-plugins\dsh-vcprag` | `afc01ec752c5e33e925939ac740f03c93c132f73` / `main` | MIT，Copyright 2026 YumenoSayuri |
| VCP 本地安装 `triviumdb` | package version `0.8.5` | Apache-2.0 |

VCP 远程 URL 包括 `C:/VCP`、`https://github.com/lioensky/VCPToolBox`、`https://github.com/cx22334/VCPToolBox-fox.git`。未 pull 原目录。以上只记录文件标注，不作法律判断。

## 直接可带入的代码

- dsh-vcprag `lib/bm25.js`: `BM25.build(docs,tokenizer)`、`search(queryTokens,limit)`、`stats()`；无外部依赖。`lib/tokenize.js`: `tokenize`、`resolveEngine`；jieba 可选，内含字符/ngram 回退。两文件已带入 `vendor/vcprag/`，只在权限域内建立独立实例。
- dsh-vcprag `index.js` 的 `apply`、`ctx.inject(['tools'])`、`ctx.tools.register`，`lib/inject.js` 的 `registerInjections`、`pickTrigger`，以及 `lib/message-channel.js` 的 `attachMessageChannel` 可以参考真实接线。pre-step 必须使用尚未落库的 `liveUser`；注入通过返回 `decision.messages`，不是写 inbox。该模式会形成持久 user 消息，不是临时上下文。
- `lib/embed.js` 是 OpenAI-compatible `/v1/embeddings` 传输，不能原样冒充 Google 原生接口；本插件重写传输，只借鉴批处理与取消思路。
- 不整体引入 `recall.js`、`freeze.js`、`diary-sink.js`：前者带可选生成式 judge，冻结与全库统计没有本方案的 ACL/撤回契约，后者允许模型正文块直接触发修改日记。

## 本地旧浪潮的真实依赖与保真路径

`TagMemoEngine.js` 不是 TDB 外壳，依赖 SQLite `tags/file_tags/chunks/files` 与派生表。直接依赖文件只有 `EPAModule.js`、`ResidualPyramid.js` 和 Node 内置模块。其 `buildDirectedCooccurrenceMatrix`、`_propagateSpikes`、`applyTagBoost`、`geodesicRerank` 是可保留的实际 JS 算法主体。

EPA 包含真正的 JS K-means/PCA/投影回退；Residual 包含真正的 JS Gram-Schmidt/handshake。查询侧 `tagIndex` 可只实现 `search(Float32Array,k)`，返回 `{id,score}`，以 TDB 标签索引适配。geodesicRerank 的候选 id 必须对应 SQLite `chunks.id`，不能直接使用无映射的 TDB node ID。

但当前 `initialize()` 强制 EPA 延迟 Rust 重算，且不再加载 JS 图；`doMatrixRebuild()` 已强依赖 Rust 生产链。不能照抄初始化就声称算法已运行。Pairwise/Intrinsic 重算没有 JS 回退。可用原生包只构建派生表，再加载回原 JS 引擎；原生 `computePairwiseSimilarities`、`computeIntrinsicResiduals` 只使用实例维度和 SQLite 路径，源码未读取该实例 ANN 内容。`new VexusIndex(dim,capacity)` 可作为构建器，不必复制全部知识库管理器。

原生方法：`computePairwiseSimilarities(dbPath,modelSig,minSimilarity,fullRebuild)`、`computeIntrinsicResiduals(dbPath,maxSvdRank,minNeighbors,modelSig,effectiveConfigJson)`；EPA 还可用 `computeEpaBasis` / `publishEpaBasisCache`。SQLite schema 在 `modules/knowledgeBase/schemaManager.js`。所有这些文件均只是可重建索引/资产，不存独有记忆状态。

`TagMemoV10Engine.js` 另外依赖整个 `modules/tagmemoV10/`、V9 transport、provenance 和持久资产；当前生产查询已迁往 Rust MemoRuntime。构造器明确使用全局 Tag 图，请求级文件过滤不能替代 ACL 隔离。对独立插件而言，按读取域提供独立资产比带入整个 VCP 服务更可控；不得用自制 PPR 代替原算法并沿用名字。

## 当前安装 TDB 的真实 API

依据 `node_modules/triviumdb/triviumdb.d.ts`（0.8.5）：

```js
new TriviumDB(path, { dim, dtype: 'f32', syncMode: 'normal', storageMode: 'mmap', loadTextIndex: true })
db.insert(vector, payload) // numeric ID
db.upsertWithId(id, vector, payload)
db.batchInsert(vectors, payloads)
db.indexText(id, text)
db.indexKeyword(id, keyword)
db.buildTextIndex()
db.search(vector, topK, expandDepth, minScore, payloadFilter)
db.searchHybrid(vector, text, topK, expandDepth, minScore, hybridAlpha, payloadFilter)
db.searchAdvanced(vector, config)
db.link(src, dst, label, weight)
db.reachable(id, options)
db.querySubgraph(id, options)
db.searchGraphFirst(vector, anchorIds, topK, maxAnchorNodes)
db.delete(id); db.flush(); db.close()
```

结果为 `{id,score,payload}`。类型声明说 payloadFilter 在向量候选阶段生效，但没有承诺词频、图统计均隔离，所以本插件分域实例。没有发现独立 BM25-only 公共方法，`searchHybrid` 仍要求查询向量；Google 不可用时使用独立 BM25 域实例，不假称调用了不存在的 TDB 词法 API。

`TDBKnowledge.js` 值得借鉴的部分是按库 `.tdb`、串行库队列、持久 ingest_queue 和 `searchWithVector` 避免重复嵌入；它是冷知识库服务，不宜直接带入独立记忆插件。

## 静态可见、移植时需改的点

1. `TDBKnowledge.searchWithVector` 将空 libraries 解释为全库；本插件必须空范围返回空。`safeLibraryName` 字符替换也可能使不同名称撞到一个文件，应改用稳定范围哈希。
2. TDBKnowledge 的 `expand` 直接按路径展开当前全文，缺少本方案的修订、来源摘录授权和预算边界，不复用。
3. 旧 TagMemo `loadIntrinsicResiduals` 不按 model_sig 过滤；EPA `epa_basis_cache` 校验也未绑定模型/维度。分模型/维度/ACL 代次隔离缓存，避免跨空间复用。
4. dsh-vcprag `Embedder.#throttle` 注释称有锁，但代码仅计算等待时间，没有串行锁；并发 worker 可一同醒来。新传输需要真实排队，而不是照搬这个注释。
5. dsh-vcprag 的全文字面门槛、自动修改日记、常驻 runtime 档案及按消息数冻结，不符合新契约。只复用独立算法与宿主接线形状。

## 本次实现选择

先完成真实 TDB 域索引、MIT BM25 离线降级、引用与纠错原子组召回。浪潮入口在收到最新版源码后按其真实初始化接入；缺失或不可加载时明确报告 `tagmemo_unavailable`，输出须标为 baseline/lexical 降级，不能算 TagMemo 已完成。
