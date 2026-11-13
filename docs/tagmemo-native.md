# 最新原生 TagMemo 接线

本次实现固定使用 VCPToolBox 提交 `73fd165d858d64d6c849533b3ec8e01c34f69e12`，而非本地旧版 JavaScript 浪潮。导出入口是 `src/tagmemo-adapter.mjs` 的 `createTagMemoDomain`，运行时标识为 `tagmemo-native-73fd165d858d`。全部计算使用上游原生算法，不把基础检索的降级结果标成 TagMemo。

## 实际执行链

1. 调用方先从权威文件和控制状态取得完整可读集合，再传入当前 note/revision、Google embedding 与标签 embedding。adapter 用 ACL 域、文件指纹、模型、维度和上游版本形成派生目录；不同权限域从 store、标签统计、几何资产到传播图都隔离。
2. `NativeKnowledgeRuntime.openAndInitStore` 打开原生管理的 SQLite 派生库。`restoreGlobalTagIndex` 与 `restoreDiaryIndex` 恢复原生 TDB 向量派生资产，然后 `registerDiaryIndex` 注册各日记索引。一个逻辑 note 对应一个原生 file/chunk，角色和作者不同不会合并。
3. `commitIngestionBatch` 按真实 `IngestionPlan` ABI 写入正文、文件标签次序、向量槽位。每批有操作标识和文件预期版本，批次限制按原生向量预算收缩。`hydrateChunksByFilePaths` 建立 chunk ID 到逻辑 note/revision 的映射，并确认正文等于当前授权快照。缓存正文不是最终召回权威；外层 RecallService 仍检查来源、权限、撤回、关系组和预算。
4. 原版 `TagMemoEngine.doMatrixRebuild` 调用原生 `computeMemoGeometry` 与 `rebuildMemoArtifact`；原版 V10 门面只持有原生 artifact 句柄。没有执行已退役的 JS SQL/CSR 维护方法，也没有 `better-sqlite3` 依赖。
5. 每个查询调用原生 `runMemoPipeline`，由 Rust 完成 EPA、Residual Pyramid、门控、Spike 河网、双场和融合。PipelineConfig 使用该提交 Rust 默认值；`langPenaltyCrossDomain: 0.1` 与上游 KnowledgeBaseManager 生产门面的默认值一致。没有额外生成模型规划或重排请求。
6. 用原始 query 和原生 enhanced vector 分别调用不做语义去重的 `searchDiaryIndices`。只按相同 chunk ID 合并两个候选集合，随后调用原版 `RiverMemoEngine.rerank`，实际读出是原生 `rerankRivermemoTopologyV3`。这是上游真实原生入口；没有重新实现拓扑、PPR 或分数公式。River 默认配置来自原版 `memoConfig.js`，实际算法版本从 native 返回并写入 health。

这里有意不使用 `executeRiverQuery` 的联合查询路径：该路径内带候选语义去重，可能吞掉不同角色对同一事件的不同表达。分离 ANN 与原生 River 仍使用同一独立域、相同原生 artifact 和 observation handle；调用者最终仍按逻辑 revision 校验。语义相近不视为同一笔记。

当前 native 采用上游默认联想语义。`baseTagBoost` 是融合强度，设为零也不会关闭 sensing、双场和 River 拓扑，因此适配器不把 `recall.association=false` 虚构成“关闭全部联想”。要绕过浪潮须选择 baseline 引擎；本接线不宣称独立 association 开关已生效。返回原因只根据原生实际读出的语义路径、结构/场奖励标注，不伪造词法命中，也不补足低相关结果来凑数。

## 状态与错误

adapter 的 `search(queryVector, queryText, {limit,signal})` 返回 `{note_id,revision_id,score,reason}[]`。搜索在域内串行，完成或失败均释放 observation handle；关闭会等待已入队查询结束。原生 N-API 不暴露本链路的强制中断，因此 AbortSignal 在原生调用之间检查，不能保证中断正在执行的 Rust 任务。外层超时不可把迟到结果重新注入对话。

原生文件缺失/无法加载报 `TAGMEMO_NATIVE_UNAVAILABLE`；ABI、初始化、索引发布、source hydration、查询失败分别给出结构化 MemoryError。health 直接说明 native 引擎、固定提交、维度、域指纹、artifact、原生状态与实际查询算法。外层若选择降级，必须另行报告 baseline 的真实 engine，不能把降级当作移植成功。

生成目录中的 SQLite、TDB 向量、几何资产与 domain manifest 均可重建。插件的 TDB 0.9 baseline 是另一个可替换对照域；浪潮内部使用该上游 native binary 静态链接的 `vcp-tdb-index`，不冒称两套索引共享一个物理数据库。Markdown、追加原文和控制日志仍在 Vault，未迁移到索引中。

## 依赖和交付状态

运行链仅新增随包 vendor 的原生模块和 Node 内置模块，未引入新的 npm JavaScript SQL 依赖。随包带同提交 Windows x64 MSVC、Linux x64 GNU 二进制；其他平台须按 vendor 原生包自身的 Rust/N-API 构建说明构建匹配平台文件，缺失时明确不可用。禁止加载旧提交的 binary 搭配新 ABI。

原版代码与许可证保留在 `vendor/vcp`。本实现按用户要求只读源码并编写接线，未运行安装、编译、测试、lint、类型检查、试启动或原生调用；因而这里只报告实现路径与实际采用的接口，不声称已经验证运行效果或各平台兼容性。
