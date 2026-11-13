# DSH Memory Companion

下载本次源代码交付包：[dsh-memory-companion-1.0.0-dev.1.zip](releases/dsh-memory-companion-1.0.0-dev.1.zip?raw=true)（约 13.2 MB，含 vendor 原生文件；打包后未运行测试）。

版本：`1.0.0-dev.1`。这是可供装配的源代码包，按使用者要求未进行依赖安装、测试、构建、类型检查、试启动或 DSH 安装。接口按 DSH `0.2.2-rc.3` 源码接入；真实桌面运行环境、原生模块加载和提示词缓存命中均需实际使用时确认。

## 这个插件负责什么

一个 DSH 扩展包，内含占位符注册与记忆服务两个 Cordis 入口，共用一份配置，只安装一次。不修改 DSH 源码，不依赖 VCP 后端常驻。

| 部件 | 解决的问题 |
| --- | --- |
| 独立文件库 | 普通文件保存原文、角色日记、公共记录和控制状态，离开 DSH 后仍可保存与读取 |
| 来源引用 | 原文只增不改，摘录以 UTF-8 字节范围、内容哈希和逐字引文校验；有引用不等于观点为真 |
| 日记与补记 | 角色可主动追加日记；固定批次后台补记、有限修复、持久进度和预算减少漏记 |
| 更正与管理 | 模型只能提出更正/撤回；用户编辑、批准、排除、恢复和锁定由管理页执行 |
| 召回 | 自动取得候选、按权限和状态筛选、将纠错关系作为一组预算，并保存回合快照 |
| TDB 与浪潮 | TDB 0.9.0 基础索引、上游原生 TagMemo/River；索引均可由文件重建 |
| 本地管理页 | 日记/原文对照、提议、快照、任务、时间线、回放和导出 |

不包含角色日常模拟、主动发起聊天或多角色群聊。最重要的长期设定仍由使用者写入系统提示词。

## 装配到 DSH

以下命令为用户安装步骤，本次未执行。需要 Node **24.9 或以上**。随包原生浪潮文件支持 Windows x64 MSVC 与 Linux x64 GNU；其他平台需另行构建匹配版本。

1. 将整个 `dsh-memory-companion` 目录解压到长期保留的位置，例如 `C:\DSH-Plugins\dsh-memory-companion`。请保留完整 vendor 目录。
2. 在该目录安装依赖并生成自己的配置：

   ```powershell
   Set-Location 'C:\DSH-Plugins\dsh-memory-companion'
   npm install
   Copy-Item -LiteralPath '.\memory.config.example.json' -Destination '.\memory.config.json'
   ```

   npm 依赖固定为 `yaml 2.8.1` 和 `triviumdb 0.9.0`。TDB 声明为 optional dependency，是为了原生安装失败时保留文件管理和词法降级，并非取消 TDB。未提供经安装生成的 lockfile，也没有执行安装生命周期脚本。

3. 编辑 `memory.config.json`：角色名字/目录、聊天模型、嵌入配置和记忆库路径。未填写 `vaultPath` 时使用当前系统用户的 `Documents/DSH-Memory`；如自定义 Windows 路径，可写 `"vaultPath": "D:/AI-Memory"`。不要放在 `.dsh` 下。示例模型只是配置起点，需与自己的接口和账号一致。
4. 为启动 DSH 的环境提供 `GOOGLE_API_KEY`、`DEEPSEEK_API_KEY`，或在配置里修改 `apiKeyEnv` 指向已有变量。不要把密钥写进人设或 JSON。桌面应用必须能继承相应环境变量。
5. 主入口保留明确的部署门控：`security.deploymentAcknowledged` 默认为 `false`，因此**默认不会启动 DSH 记忆服务**。该实现承诺模型不能越权管理记忆；要启用，需在宿主或 OS 部署层限制模型工具直接访问记忆库、角色配置和管理凭据，再将该值设为 `true`。这只是操作者声明，不是自动隔离功能。没有这些限制时，不应宣称角色私库已经隔离；可先使用独立管理模式。细节见 `docs/host-adapter.md`。
6. 关闭目标 DSH 实例后，将本地包加入需要的 profile：

   ```powershell
   dsh plugin --profile tui add 'C:\DSH-Plugins\dsh-memory-companion'
   ```

   桌面版对应：

   ```powershell
   dsh plugin --profile desktop add 'C:\DSH-Plugins\dsh-memory-companion'
   ```

   desktop profile 需已由桌面版初始化，装配时桌面版应完全退出。选择你实际使用的 profile，不必两条都执行。包的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，两入口都读取包根的 `memory.config.json`；不需要额外安装第二个插件。移动包目录后，应按 DSH 的插件管理流程更新其来源。
7. 在 DSH 原生人设的 **prefix** 中写入以下声明，然后由用户正常启动 DSH：

   ```text
   {{mem_self_main}}
   {{mem_public}}
   ```

   每个人设恰好一个 `mem_self_<alias>`。读自己的日记不需要另写 read；如需读取另一个已配置角色的日记，加入 `{{mem_read_other}}`。`{{mem_timeline_main}}` 是时间线声明，不额外授予读取权限。声明不要放 suffix。启用运行时记忆上下文需要宿主 `includeRuntimeContext` 允许 contexts。未知角色不会被自动创建或授权。

## 配置和两个入口

`src/bootstrap.mjs` 只注册原生占位符，不导入存储、模型接口或原生索引；`src/plugin.mjs` 加载记忆服务。拆分是为了减少主模块依赖故障对占位符的影响，实际 DSH 错误隔离行为未试运行。完全卸载两个入口之前，先从人设删除 `mem_*` 引用，因为 DSH 模板使用严格变量解析。

`configFile` 可以是绝对路径，也可以相对于插件包根；不是相对于 DSH 工作目录。patch 内联的其他配置字段会浅覆盖 JSON 同名字段。通常只修改 JSON，避免双份配置漂移。

## 打开管理页

DSH 里的插件已运行时，在用户自己的终端执行：

```powershell
node .\src\cli.mjs open --config .\memory.config.json
```

命令输出当前管理链接，在用户浏览器打开即可。`open` 不会再打开记忆库或争抢库锁。DSH `/memory status` 只提供不含管理令牌的状态信息。

若不运行 DSH，可独立开启管理页：

```powershell
node .\src\cli.mjs serve --config .\memory.config.json
```

同一个库只能由一个服务持有，**不要同时运行 DSH 插件和独立 serve**。`serve` 会按配置启动后台日记任务；只想人工管理时，先将 `diary.enabled` 设为 `false`。嵌入、补记、整理和回放可能使用配置的模型额度。

管理服务只监听回环地址，默认使用随机端口。链接令牌只给用户，不应交给聊天模型。运行凭据保存在库外的 `~/.config/dsh-memory-companion/runtime/`，同样应受部署权限保护。把 HTTP 放在 localhost 不等于模型无法访问。

日记可通过管理页修改，也可在普通编辑器中修改可编辑日记文件；外部变更被 reconcile 接纳后会触发索引失效及相应保护。不要手工改写追加原文、控制日志和来源标识。完整状态与格式规则见 `docs/storage-format.md`。

## TDB 和最新浪潮

上游快照取自 `https://github.com/lioensky/VCPToolBox`，固定提交：

```text
73fd165d858d64d6c849533b3ec8e01c34f69e12
commit time: 2026-11-13T06:08:23Z
```

这是本次取得的最新快照，不代表安装时会自动追踪未来 master。上游 TagMemo 已将核心迁往原生 MemoRuntime，本包保留原版 geometry/artifact/pipeline 与 River 读出接线，不用自写评分冒充浪潮。

`recall.engine: "tagmemo"` 选择原生浪潮；`"baseline"` 绕过浪潮，使用 TDB/词法基础检索。两者是独立的可重建索引资产；浪潮内部链接的 `vcp-tdb-index` 与 npm `triviumdb` 不冒充同一个物理库。原生包不可用、接口失败或超时时，诊断会显示实际降级引擎，不把降级结果标成浪潮成功。

没有独立的 `association:false` 关闭开关：将 tag boost 设为零并不能关闭原生全套联想，因此未暴露一个无效承诺。详细算法入口、版本和平台限制见 `docs/tagmemo-native.md`。

## 维护与备份

管理页支持索引重建、导出、任务状态与审批。只有记忆服务退出后，才使用以下需独占库的 CLI：

```powershell
node .\src\cli.mjs status --config .\memory.config.json
node .\src\cli.mjs rebuild --config .\memory.config.json --role main
node .\src\cli.mjs export --config .\memory.config.json --destination 'D:\Memory-Backups\export-001'
node .\src\cli.mjs restore --source 'D:\Memory-Backups\export-001' --destination 'D:\Memory-Restored\copy-001'
```

恢复仅复制到不存在的新目录，不能覆盖正在使用的库。导出时的排除与控制状态需要一起保留；不可仅复制正文后宣称已完整恢复撤回状态。索引可重建，但原文、日记与控制记录不是可随意删除的缓存。

## 交付边界

- 本次只实现、装配并打包源文件。未实际安装依赖、加载 native、启动服务或连接 DSH；所有兼容性与行为仍未经过运行验证。
- 原生 contexts 会进入会话历史，不能宣称临时注入或保证前缀缓存命中。撤回/权限收窄/旧修订已进入历史或累计预算超限时，适配器会要求新的干净会话；没有自动清空宿主历史或摘要的可靠接口。
- 捕获的是宿主提供的文本。未实现图片/附件二进制归档，也不能恢复已经被宿主截断的工具全文。工具文本捕获默认关闭。
- 身份解析针对原生 persona prefix；不承诺兼容任意第三方人设替换。消息格式迁移导致身份变化时，需要明确迁移映射，不能靠猜测合并。
- 角色权限由插件入口约束；阻止模型其他工具绕过入口访问文件依赖实际部署隔离，本包没有实现独立权限的存储 RPC 服务。
- token 预算采用保守 UTF-8 字节估计，并非目标模型精确 tokenizer。模型响应中的 usage 单独记账。
- 单次整理最多 30 条，超量月目录仍列全，摘要生成返回可见错误。手动整理/回放未提供通用重试按钮，不会静默重复收费请求。

原设计文档保存在 `docs/design-v1.0.md`，表达设计目标；当前交付边界以本 README 和各部件实现说明为准，不把设计验收条目当成已执行的测试。

## 源码导览

`src/vault.mjs` 与 `src/storage/` 为权威文件层；`src/diary.mjs` 为补记/提议/回放；`src/index-engine.mjs`、`src/tagmemo-adapter.mjs`、`src/recall.mjs` 为检索；`src/plugin.mjs` 为宿主适配；`src/management.mjs` 与 `ui/` 为用户管理；`src/service.mjs` 负责组合和关闭。许可和复用项目见 `THIRD_PARTY_NOTICES.md`。
