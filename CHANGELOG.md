# Changelog

## Unreleased

- Make direct `curl` the recommended path for one-off URL tasks; keep the Node.js CLI for
  reusable setup, full-registry probing, batch work, offline rendering, and artifact layout.
- Keep Python files as thin compatibility wrappers instead of a second API client and artifact
  pipeline.
- Add `setup`, `import`, `add`, and `probe` full-registry Token probing through `/v1/me`,
  persisting only non-sensitive authorization/quota snapshots.
- Add purpose-aware filename suggestions for summaries, detailed summaries, structure notes,
  operation manuals, learning notes, and transcripts.
- Stop subtitle acquisition from creating a main-document placeholder. Keep timeline lookup,
  evidence, coverage, and boundaries in source sidecars.
- Reduce the core skill guidance and references while retaining bilingual README switching.
- Remove duplicated workflow/reference files that repeated the same subtitle and output rules.
- Add offline coverage for all-token probing, purpose-aware filenames, sidecar boundaries,
  and Python-to-Node compatibility.

## 1.0.0 - 2026-08-10

- 整理为可独立发布、可通过 `npx skills` 发现和安装的标准 skill 仓库。
- 保留字幕优先架构：BibiGPT 负责字幕获取，Codex 负责总结、结构梳理、学习文档和问答。
- 增加项目级 Token 配置、隐藏输入、0600 权限、非交互保护和脱敏产物流程。
- 增加离线验证脚本与单元测试，不需要真实 API Token 或网络即可检查仓库和本地字幕处理路径。
- 保留 `summary`、`hybrid` 和旧脚本入口作为字幕-only 兼容别名。
