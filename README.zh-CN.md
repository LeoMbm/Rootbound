# Rootbound — 中文说明

> **V5 文档状态：正在同步。**
>
> 当前这个文件不再保留旧版 V4 / Task Card / Agent 流程说明，因为那些内容已经和 V5 实现不一致。
>
> 在完整中文 V5 文档翻译完成之前，请以英文 [`README.md`](README.md) 和 [`docs/plans/rootbound-v5.md`](docs/plans/rootbound-v5.md) 为准。

## 当前 V5 核心变化

- ChatGPT 作为推理层；Rootbound 暴露经过接受和验证的 model-free 本地能力。
- 公开 surface 为 `rootbound-public-preview-v5`。
- 当前公开工具数：27。
- 不再把 Codex Agent / Task Card / model routing 作为公开 V5 surface。
- 本地状态持久化到 SQLite。
- 项目使用稳定的 `projectRef`。
- `rootbound connect .` 负责项目解析、exact-root trust、doctor、registry 和 supervised runtime。
- 长命令支持 `start / poll / write / terminate` 契约；Windows 对交互 streaming 使用明确 fallback / unsupported 行为。
- `workspace_open` 是 V5 推荐的项目入口。
- `repo_search` / `read_many` 支持分页。
- `precise_edit` 支持 SHA-guarded undo / redo。
- continuity binding / checkpoint 支持持久化和幂等 retry。
- tunnel 配置可以持久化 argv 模板，但不允许保存 literal credentials；秘密应通过 `{env:VARIABLE}` 注入。
- diagnostics 会对路径和凭据进行脱敏，并且不会导出命令 stdout / stderr 或 thread preview。

## 安装要求

- Node.js >= 22.13.0
- 本机已有受支持的 Codex 安装
- 当前 Technical Preview：Windows + Apple Silicon macOS

## 日常 CLI

```text
rootbound tunnel configure ...
rootbound connect .
rootbound status
rootbound self-test .
rootbound logs
rootbound diagnostic
rootbound stop
rootbound upgrade --from <release-dir>
```

## V5 状态

V5 仍在 `feat/thread-history-continuity` 分支上进行最终稳定化和真实机器验收，尚未合并到 `main`。

详细功能、安装、security boundary 和 release checklist 请查看：

- [`README.md`](README.md)
- [`SECURITY.md`](SECURITY.md)
- [`docs/plans/rootbound-v5.md`](docs/plans/rootbound-v5.md)

完整中文 V5 README 会在 release contract 稳定后再同步，避免再次出现“翻译文档落后于真实实现”的问题。
