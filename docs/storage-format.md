# Vault 文件格式与管理语义

本文件说明当前源代码实际实现的存储层，不代表已经运行、测试或验证。实现入口为 src/vault.mjs，内部模块为 src/storage/format.mjs、io.mjs、mutations.mjs。运行依赖 Node ESM 和 yaml ^2.8.1。JSON Schema 位于 schemas/vault-v1.schema.json；它描述生成文件的主要结构，不替代运行时权限、引用、状态和字节范围检查。

## 文件与权威边界

| 路径 | 内容 |
|---|---|
| vault.json | schema_version=1、vault_id、创建时间、角色目录映射 |
| 原文/YYYY-MM/*.jsonl | 原始文本事件及经确认的 branch_ref；只追加，分段损坏不截断原文件 |
| 公共/YYYY-MM/*.md | 共同可读范围内的署名条目 |
| <角色目录>/日记/YYYY-MM/*.md | 日记 |
| <角色目录>/印象/YYYY-MM/*.md | 有来源的主观看法；不构建“当前真相” |
| 修订/<note_id>/<sha256_hex>.md | 精确文件字节快照，文件名没有 sha256: 中的冒号 |
| 关系/<relation_id>.json | 不可变的关系提议 |
| 提议/<proposal_id>.json | 确切新正文、预期修订、拟执行效果、原始角色绑定 |
| 控制/actions.jsonl | 顺序控制日志，带 log_seq、前条摘要及当前记录摘要 |
| 控制/checkpoint.json | 最近持久控制水位；缺失或链校验失败时停用依赖状态的操作 |
| 控制/writer.lock | 单进程写者锁；关闭时只删除自身 nonce 对应的锁 |
| 状态/<key_hash>.json | 补记、预算等服务状态；文件保存原 key，不能丢进可重建索引 |
| 注入记录/YYYY-MM/*.json | 已保存的冻结快照，同 snapshot_id 不允许换内容 |
| 暂存/<operation_id>/ | 准备中的确切字节和恢复计划 |
| 索引/ | 不属于本模块的权威存储，可由检索模块重建 |

日记为安全 YAML 1.2 front matter 加 Markdown 正文。禁止自定义标签、重复键和别名展开。body、revision_id、path 不存进 front matter；读取时计算 revision_id = sha256: + 文件精确字节摘要。不先转换换行、Unicode 或空白再计算指纹。程序生成带前缀 UUID；配置 role_id 也接受稳定可读 slug。目录限制为一个兼容 Windows 的组件，不允许目录穿越、保留设备名和库内符号链接。

## 原文与证据

Event 包含 source（实例、会话、原生消息 ID、原生版本）、branch_id、context_id、context_role_id、speaker、origin、source_time、captured_at、text 和 text_sha256。source_time 只来自上游明确时间；captured_at 不冒充历史时间。

capture 以真实上游身份和版本幂等。同一原生消息在缺少原生版本时的不同已观察文本会留作不同观察；全库相同文字绝不据此合并。若上游根本没有稳定身份，则每次分配独立 event_id。分叉复用须由适配器显式传入 fork_verified、parent_branch_id 和 inherited_from_event_id，且文本、说话者、上下文匹配；不会靠内容相似猜分叉。上游缺失版本时无法保证识别所有“改回旧文本”的历史转换，应由适配器优先提供真正版本身份。

plugin_synthetic、带 snapshot_id 的合成事件，以及身份未绑定事件不能作为直接原话证据。原文捕获记录可见文本；工具附件原始字节不在此 capture(text) API 自动保存范围内，不宣称已完整备份外部资源。

resolveSources(refs,binding) 接受事件 ID 或显式引用，核对权限、原文摘要及 UTF-8 字节半开区间，并返回逐字 quote、前后短上下文及 quote_check=quote_found。无选区时引用整条文本，过大时拒绝而非静默截断。quote_found 只证明原话存在，不证明日记概括为真。同步 getSourceExclusions(eventId) 和 isSourceExcluded(ref) 供补记层保守过滤；不能把删除后的两侧原文拼接成一句新话。

## 写入、修订及外部编辑

appendNote 只使用绑定中的作者和上下文，忽略正文试图指定的身份或路径。直接新增日记不需要人工审批；没有 public 写权限时，public 请求保存成提议，返回 proposal_id/pending，不偷偷写入公共目录。

editNote 是管理入口，要求 exact expectedRevision，只能编辑正文及 tags、facets、stance、about_time 等允许字段。既有来源和派生引用保留；编辑不解除已有排除，用户编辑后锁定。用户无来源手写使用 appendNote 的受信选项 origin=user、user=true。模型入口不能取得这些选项。

reconcile 扫描受管当前目录。无法归属于插件已登记操作的修改记录为 external_unattributed，不认证为人类；保存观察到的修订并保守锁定。身份字段变化、重复 note_id、无效来源等暂停该文件的自动使用。外部删除生成持久排除及已关联来源范围；之后重新放回同 ID 文件也不会自行恢复召回。reconcile 返回 changed、errors；没有控制变化不会要求宿主清空本回合快照。外部编辑器每一次瞬间版本不能保证都被捕获。

## 关系、撤回、排除与恢复

模型通过 propose 创建关系或整理建议；关系文件 initial_status 不决定当前状态，状态来自控制日志。支持 claims_correction、claims_retraction、supplements、related。用户确认关系本身不自动隐藏目标；只有预览里列出的 withdraw/exclude/archive 等效果才会执行。替代条目消失、关系 stale、外部产生新修订均不会自动复活旧条目。

管理 action 支持 withdraw、exclude、restore、lock、unlock、usage、archive。usage_policy 为 normal、prefer_when_relevant、explicit_only、excluded。锁定与召回资格独立。

- withdraw 记录具体旧修订，并持续暂停同 note_id；外部改个 hash 不会绕过暂停。
- exclude 可指向具体条目、全部修订（*）和精确 source_exclusions。
- restore 必须指定批准的具体当前修订；默认只解除所选 note 的既有暂停，不自动恢复来源排除。恢复来源须明确携带 source_exclusions，可用 restore_action_ids 限定原排除动作。
- selected body_spans 只标记撤回范围，不自动拼接剩余正文。没有完整安全文本时整条暂停；管理端可传 action.approved_body，由同一操作发布用户批准的新修订、撤回旧修订，并仅恢复该新修订。
- 派生引用包含 note_id/revision_id 或 snapshot_id；快照会展开成确切条目引用。源修订变化、来源排除、祖先失效会阻止派生内容默认使用。已建立的依赖可以阻止复活，不声称识别所有未建立关联的同义陈述。

## 操作恢复与导出

操作先存完整暂存字节与 prepared 计划，再发布文件，最后追加 operation_commit。creation_operation_id 未提交的内容不可进入召回。用户编辑的旧字节先保留为修订快照；未提交替换不会被误当成已批准新版本。冲突时只回退仍与操作字节完全一致的目标，外部另改的文件保留并报告。普通 I/O 中断保留准备状态，重新打开时尝试完成确切原操作；不会重新调用模型生成另一份正文。

写入幂等键同时绑定 payload hash：同键同内容返回原回执，不同内容报冲突。appendNote 用 idempotencyKey，propose 用 idempotency_key，管理 action 接受 idempotencyKey 或 operation_key；decide 使用 proposal ID 和 proposal_hash。编辑可在 patch.idempotencyKey 指定键。

控制日志按序号与摘要链重放，并检查持久水位。链损坏、缺失、截断或无法确认写入结果时，依赖控制状态的召回和写操作停止；原文捕获仍可按可用身份保留材料，不把部分日志当空状态继续运行。操作提交后的临时文件清理失败不能撤销已提交决定。

exportTo(destination) 输出到空的库外目录，复制权威文件、状态与快照，省略索引、写锁和暂存，附每个文件的摘要清单和控制水位；存在未解决 prepared 操作时拒绝宣称备份成功。目标路径额外限制由管理服务执行。此模块提供导出，没有以不受控覆盖现库实现导入恢复；恢复现库须另走用户明确选择的受控目录流程。

## 接口补充与来源

除 implementation-contract.md 的 Vault API，还提供：

- async resolveSources(refs,binding) -> Source[]
- getSourceExclusions(eventId) -> 已生效排除范围[]
- isSourceExcluded(ref) -> boolean
- action({action:'withdraw',targets:[...],approved_body:'用户批准的完整正文'}) -> 提交回执

规则移植参考 astrbot_plugin_private_companion 提交 38212f66de2a3629fbbac41416525fc519d0f195 的 MemoryAccess.capture/evidence、MemoryWriter.submit/commit_pending、MemoryManagement.command、RoleJournalWriter._target_current、sources.dependencies。原仓库实际声明 AGPL-3.0-only；来源清单保留在 work/reuse-companion.md。这里未嵌入其 SQLite 事实模型、AstrBot 身份系统、离线生活或系统人格注入。

