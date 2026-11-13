# DSH 宿主适配

本模块根据本地 `dsh 0.2.2-rc.3` 源码接线，未运行测试、检查、构建或宿主试启动。没有修改 DSH 核心，也没有安装插件或改动用户的 DSH 配置。

## 包和依赖

入口为 `src/plugin.mjs`，导出 `name`、`inject`、异步 `apply(ctx,config)`；另有真正独立的 `src/bootstrap.mjs`，只依赖 `systemPrompt`，不导入 TDB 或业务服务。`cordis.patch.yml` 插入两行，两者共享角色配置。主模块失败不会由代码主动移除另一个 bootstrap 行；宿主最终装载行为仍未实跑。

主模块依赖注入 `systemPrompt`、`tools`、`sessionPersistence`，可选接入 `commands`。没有新增 npm 运行依赖；Node >=24.9，业务服务通过本包 `createMemoryService` 取得。整个包需要将两份入口、patch及业务文件纳入发布文件。

## 使用的源码入口

源码根：`C:\重构工程\deepseek-harness`。

| 功能 | 当前源码依据 |
|---|---|
| 注册变量 | `packages/core/system-prompt/src/index.ts:568`，`variable(name,provider):()=>void`；undefined 会导致引用模板失败 |
| 原始人设模板 | 同文件 `:31,125` 的 assembly waterfall 和未插值 sections；原生 persona 在 `packages/preset/persona/src/index.ts:62` 注册 `deployment:persona-prefix` |
| 异步召回 | `packages/core/agent/src/runtime-types.ts:351` 的 async `agent/pre-step` waterfall，包含 agent/messages/turn/step/signal |
| 同步注入 | `packages/core/system-prompt/src/index.ts:79,520` 的 `context`；text 必须同步返回字符串 |
| 请求前刷新 | `packages/core/agent-loop/src/agent.ts:452–482` 刷新 context 并追加 user/message |
| 原文通知/排空 | `packages/core/session/src/index.ts:79,87`，`session/event` 是提交后通知，`session/flush` 可等待插件队列 |
| 补抄 | `packages/session/session-persistence/src/index.ts:174`、`handle.ts:83,116`，只读 open/read/close |
| 模型工具 | `packages/core/tools/src/index.ts:128`，definition 必须有 output schema/render及execute(args,exec) |
| 用户状态命令 | `packages/interaction/commands/src/index.ts:285`，不向模型输出管理凭据 |

采用 dsh-workspace-docs 的命名 context 注册方式，以及 dsh-vcprag/现有插件的 pre-step 接入模式。没有复制 time-weaver 对 `session.deriveMessages` 的替换。源码调查详见项目外的 `work/reuse-dsh.md`；这里不宣称参考插件可以原封不动兼容。

## 身份与捕获

只解析原生人设 **prefix** 中的 mem 声明。请把 self/read/public/timeline 全部写在该前缀，不能放 suffix；这是为了避免 `complete:true` 时被宿主抑制的 suffix 仍被误当授权。第三方插件任意替换最终完整人设的组合目前没有可靠的“最终生效原模板”读取接口，不能据此宣称支持；需要显式宿主适配。

无 mem 声明的会话不参与主动记忆。声明恰有一个 self；读取自己的目录，加显式 read/public，timeline不授予权限。未知别名和重复self报错。模型不能设置作者、role、文件路径或审批状态。每次绑定持久保存身份区段和生效序号；历史补抄依据已保存区段，不把现在的角色强行套给过去。

当前实现捕获 user/message、assistant/message、tool/result 的文本块，保留非文本块的类型和ID描述；**不声称复制了图片、附件二进制或宿主已截断的 spill 全文**。用户、助手、工具分别标 user_input/assistant_output/tool_output；runtime-context及其他合成来源为plugin_synthetic且不可充当原始证据。助手记录关联当时召回快照，不能冒充用户亲口说过的事实。

消息ID＋来源实例＋会话＋内容修订用于捕获幂等；没有可信分叉原始归属的 inherited 事件保存但不可作为自动来源。`session/event` 不是磁盘事务屏障，失败会进入诊断；flush拒绝静默吞掉未保存记录，后续只读补抄可重试。原生格式迁移如改变消息身份仍需明确迁移映射，当前代码不伪造跨迁移身份保证。

## 回合快照与无法隐瞒的宿主限制

async pre-step完成召回；context回调只读取已完成快照。每步重复请求由RecallService保持本回合冻结并重新检查权限/排除。Admission又会刷新context，但不会在provider内发出模型或embedding请求。

原生contexts写入持久user-role快照，内容变化才追加；这不是不落历史的临时注入。本插件不提供缓存命中保证。它记录已进入会话的记忆修订和累计预算；源记忆已修改/撤回/排除、权限收窄或累计预算超过上限时，后续step明确报错，要求用户建立不继承旧历史或旧摘要的新会话。

**当前没有接入已确认的自动建立干净会话/删除旧surface接口。** 因此代码不会声称删除来源已经清除了旧上下文，也不会偷偷 monkey-patch 历史。管理页的“清理当前上下文”应呈现为需新建干净会话的操作指引，不能展示虚假的清理成功。本实现保守保留已注入记录，即使宿主压缩后也不假装能够证明摘要完全不含旧内容。

`includeRuntimeContext:false` 会按宿主规则屏蔽可选contexts；本模块不强行设置required绕过该选择。需要自动记忆注入时，使用支持runtime context的原生persona配置。

## 工具与用户管理

- `memory_note`：追加有来源日记，以及提出claims_correction/claims_retraction；来源选择受当前回合已捕获事件ID集合约束。公共新增仍由Vault决定直接追加或转待审批提议。
- `memory_evidence`：按已知note ID或明确来源范围取证，不作为全库自主检索工具。检查读取权限、排除及来源范围，输出区分用户/助手/工具。
- `/memory status`：只给用户状态，不返回管理token，也不通过模型`confirm:true`批准提议。
- 编辑、删除、授权及提议批准由独立管理服务/CLI处理。本文件不开放模型管理工具。

## 部署门控，不冒充OS隔离

DSH现有 `fs-sandbox` 源码明确允许所有模式读取，SandboxPolicy也没有私库读排除字段；shell的full-access模式会绕过confinement。仅注册memory工具或tools.guard不足以保护全库。

因此主适配器默认拒绝启动，要求同时配置 `security.mode:'host-enforced'`、`security.deploymentAcknowledged:true`。这表示操作者已在宿主或OS层落实以下部署要求，**不是代码自动证明了要求成立**：所有模型可控文件/shell/子进程都不能直接读写私库、身份配置和审批记录；模型浏览器/HTTP工具无法使用管理会话；管理凭据不能被模型读取。

可采用独立权限的存储/执行部署或专门受限provider完成边界；同用户同权限localhost服务或Node helper不够。本版本没有虚构外部存储协议，也没有实现一个声称安全但实际仍同权限的RPC层。若现有部署不能实现这些条件，保持门控关闭，独立用户管理仍可用于人工操作；不能把门控关闭说成已经完成受隔离的DSH部署。

## 配置扩展

`host.instanceId` 可指定来源实例；否则在库状态中生成并持久保存。`host.contextOrder` 默认140；`host.captureTools:false` 关闭工具文本捕获；`host.persistenceBatchSize` 默认200；`host.evidenceTokenBudget` 默认使用recall.tokenBudget。`host` 和 `security` 应由统一配置归一层保留并验证。角色、Google/chat键和预算仍由项目统一配置提供，bootstrap的角色别名应与主模块一致。

## 本地 bundle 装配与用户管理入口

包名为 `@local/dsh-memory-companion`。`package.json` 应声明 `dsh.bundle.patch: "./cordis.patch.yml"`，导出 `.` 到 `./src/plugin.mjs`、`./bootstrap` 到 `./src/bootstrap.mjs`，发布时包括业务源码及其依赖的静态资源。适配层没有直接导入 DSH/Cordis 包，不要求额外 npm peerDependencies；运行时需要注入 `systemPrompt`、`tools`、`sessionPersistence`，`commands` 是可选服务。

源码 `packages/boot/app-boot/src/index.ts:560–565` 将 patch 中 `./`、`../` 的插件名相对于 **该 patch 所在目录** 转为文件 URL。随包 patch 位于包根，所以它使用的 `./src/bootstrap.mjs` 和 `./src/plugin.mjs` 均相对于本插件包根；若把 insert 行复制到用户 profile 的 patch，则必须同步改为相应绝对路径或包导出名称，不能原样假定仍相对于插件包。

CLI 实际语法见 `apps/cli/src/args.ts:99,155`。以下仅为用户之后的装配命令，本次未执行：

```powershell
dsh plugin --profile tui add "C:\Users\Kabuqinuo\Documents\Codex\2026-11-13\new-chat\dsh-memory-companion"
```

把 `tui` 换成实际使用的 profile。Desktop 使用 `desktop`；`apps/cli/src/plugin.ts:11–14` 要求先由 Desktop 打开一次以初始化 profile，再完全退出后运行该命令。`plugin-manager/src/operations.ts:95–126,566–567` 会把新安装且声明了有效 bundle 的依赖加入 `dsh.profile.bundles`。包管理器/平台/版本限制仍可能拒绝安装；这里不声称已经安装或实际加载成功。`install-spec.ts:70` 接受本地绝对路径及绝对 `file:`、`link:` spec。

随包 patch 是实际装配示例，两行均使用 `configFile:'./memory.config.json'`。安装前把随包 `memory.config.example.json` 复制为 `memory.config.json` 并配置；缺失、不可读、无效 JSON 或非对象会明确报错，不静默使用空配置。相对 configFile 由只依赖 Node 内置模块的 `src/host-config.mjs` 通过 import.meta.url 从**插件包根**解析，也支持绝对路径。若修改 profile 的用户 patch，可分别针对 `id: memory-companion-bootstrap` 和 `id: memory-companion` 设置同一个绝对 configFile。配置文件内容先加载，再以同行其余内联字段浅覆盖，不做递归合并；宿主 patch 的 `config` 本身同样是整块替换。两入口必须使用一致角色配置。

示例配置中的 `deploymentAcknowledged:false` 会让业务插件明确拒绝启动；只有配置 JSON 可读且有效时，独立 bootstrap 才能提供稳定占位符。它不导入业务服务、TDB 或模型提供商，业务模块加载失败不会连带卸载这条 bootstrap。正式启用前须完成前述部署隔离并填写实际 vault/provider/预算/管理配置。不要在模型可读的配置中写管理 token 或提供商密钥。

服务已由 DSH 打开时，在用户终端中进入本插件包目录，通过以下入口取得当前管理地址：

```powershell
node src/cli.mjs open --config "C:\用户配置目录\memory-config.json"
```

该命令由项目 CLI 实现，读取本次服务的用户 runtime 凭据文件，不再打开第二个 Vault。它不是 DSH 启动器。配置应指向与宿主完全相同的库；runtime 凭据文件必须纳入模型工具隔离范围，不入记忆库、备份或模型会话。`/memory status` 只提示此用户入口，不输出管理 token。

`memory_note` 的 `tags`/`facets` 为最多 12 个、每项最多 80 字符的字符串数组，`stance` 为 `observation|interpretation|feeling`。模型必须显式提供 1–12 条来源及精确 `quote`。首轮当前原文 ID 尚未出现在召回快照时，可以先调用 `memory_evidence({current_turn:true})`，只取得宿主本轮已采集白名单内、当前有权读取且未排除的来源，再提交日记；这不提供全库枚举。最近上下文传递的是已采集 Event，召回服务重读并验证来源。原生 `SessionEvent.time` 是 Unix 毫秒，适配器转为 ISO 时间保留事件时间。

bootstrap 是唯一占位符注册者，主插件不重复注册。保留同一个 bootstrap 行可以让业务插件停用时模板仍可展开；重复注册同名变量会明确失败。卸载整个包前，先从人设 prefix 移除其所有 `{{mem_*}}`，或显式迁移到另一个仍在加载的独立 bootstrap；包完全缺失时不能承诺占位符自行兜底。已注入旧记忆的会话仍须按前述规则建立干净会话，卸载不会抹去其历史。