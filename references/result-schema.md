# 内部结果结构

字幕获取阶段统一成以下概念，不规定 BibiGPT 服务端必须返回完全相同的 JSON：

```json
{
  "source": {
    "input": "...",
    "platform": "bilibili",
    "title": "...",
    "author": "...",
    "durationSec": 123
  },
  "transcript": {
    "cues": [
      {"index": 0, "start": 0, "end": 1.5, "text": "..."}
    ],
    "cueCount": 1,
    "firstStart": 0,
    "lastEnd": 1.5,
    "coverage": "..."
  },
  "provenance": {
    "provider": "bibigpt",
    "operation": "getSubtitle",
    "transport": "api",
    "complete": true
  }
}
```

`summary`、`chapters`、`learningNote` 不属于字幕获取脚本的服务端结果；它们由 Codex 在当前任务中根据字幕生成。
