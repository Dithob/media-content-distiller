# BibiGPT API 兼容说明

本 skill 的内容主链路固定为：

```text
GET /api/v1/getSubtitle
```

`/v1/summarize`、`/v1/summarizeWithConfig` 和 `/v1/summarizeByChapter` 不属于新版本正常链路；快速总结、详细总结、章节结构和学习文档由 Codex 基于字幕完成。

详细的当前字段以 BibiGPT 官方 OpenAPI 为准。此文件保留用于旧路径兼容，新的流程说明见 `acquisition.md`、`result-schema.md` 和 `validation.md`。
