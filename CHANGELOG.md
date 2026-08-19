# Changelog

## Unreleased

- Make the skill-owned Node.js CLI the only normal subtitle acquisition path: public URLs
  use the bundled BibiGPT API client with `/v1/me` followed by `/v1/getSubtitle`.
- Remove the accidental dependency on external command/skill adapters. The CLI now owns
  Token resolution, API requests, normalization, rendering, batch processing, and artifact layout.
- Keep local media handling explicit and safe: the URL-only API rejects local files without
  uploading them or making a network request.
- Restore the Python entry point to API-only compatibility behavior with the same subtitle
  format, credential lookup, redaction, and error semantics as the Node.js CLI.
- Add offline Node regression coverage for API request order, summary-endpoint exclusion,
  local-file safety, batch processing, artifact layout, Token redaction, and registry checks.
- Keep the complete English README at `README.en.md` and reciprocal `English | 中文` links.

## 1.0.0 - 2026-08-10

- 整理为可独立发布、可通过 `npx skills` 发现和安装的标准 skill 仓库。
- 保留字幕优先架构：BibiGPT 负责字幕获取，Codex 负责总结、结构梳理、学习文档和问答。
- 增加项目级 Token 配置、隐藏输入、0600 权限、非交互保护和脱敏产物流程。
- 增加离线验证脚本与单元测试，不需要真实 API Token 或网络即可检查仓库和本地字幕处理路径。
- 保留 `summary`、`hybrid` 和旧脚本入口作为字幕-only 兼容别名。
