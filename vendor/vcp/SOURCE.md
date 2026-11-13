# VCP MemoRuntime vendor 来源

- 仓库：https://github.com/lioensky/VCPToolBox
- 固定提交：`73fd165d858d64d6c849533b3ec8e01c34f69e12`
- 提交时间：2026-11-13 06:08:23 UTC
- 上游根许可证：CC BY-NC-SA 4.0，原文保留在 `LICENSE`。
- `UPSTREAM-SNAPSHOT.json` 保留下载来源、固定提交、各 blob ID；它描述读取的上游源快照，并非本 vendor 的精简文件清单。

原样保留 `TagMemoEngine.js`、`TagMemoV10Engine.js`、`RiverMemoEngine.js`、对应配置/不可变对象/可观测性辅助模块，以及 `rust-vexus-lite` 的 JS loader、类型声明、Rust 源码、本地 crate、Cargo 锁文件及构建说明。Windows x64 MSVC 和 Linux x64 GNU 的 `.node` 是该固定提交中的上游预编译文件；本项目未编译、加载或执行这些文件。

`KnowledgeBaseManager.js`、`modules/knowledgeBase/ingestionPipeline.js` 和 `indexRepository.js` 作为接线出处保留，不由插件导入，因此不把上游服务器或其依赖带进 DSH。

本目录新增 `package.json` 仅声明 CommonJS 边界，防止宿主 ESM package 改变原版 `.js` 的解释方式。DSH 的独立适配在 `../../src/tagmemo-adapter.mjs`。适配器没有修改、替换 Rust 算法；没有用自写 PPR 或 baseline 充当 TagMemo。

原生包的其他第三方依赖由随附 Cargo.toml/Cargo.lock 记录；上游预编译文件的构建来源按本次源快照记录，不声称已复现其构建。
