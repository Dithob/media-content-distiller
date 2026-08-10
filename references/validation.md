# 转录与交付校验

## Required checks

- JSON 可解析；
- 至少识别 `subtitlesArray`、`subtitles[]` 或 `body[]`；
- 每条 cue 的 `start`、`end` 是有限数字，且 `start <= end`；
- cue 的开始时间不倒退；
- 记录 cue 数、合并段数、首条时间、末条时间、视频时长和覆盖判断；
- 字幕为空、时间轴异常或覆盖明显不足时，停止并报告范围；
- raw、metadata、transcript 中不出现 Token、Cookie、Authorization 或完整认证参数。

## Grouped transcript

默认每 10 条 cue 为一组，组内直接换行：

```markdown
句子 A

句子 B
```

不要默认插入 `〔句间分隔〕` 或其他看似正文的伪文本。用户可以通过 `--sentence-separator '|'`、`--sentence-separator space` 或自定义字符串改变分隔风格。

## Artifact layout

- 主产物放在 `media-artifacts/` 根目录，使用清理后的标题命名；
- 副产物放在 `media-artifacts/<source-id>/`；
- 副产物固定使用短名称：`README.md`、`raw-subtitle.json`、`metadata.json`、`transcript.md`、`status.json`；
- `media-artifacts/README.md` 和来源目录内的 `README.md` 都必须能导航到相关产物；
- 主产物正文必须包含指向来源目录 README 的副产物导航；
- 原始字幕和状态文件仍须通过敏感信息扫描。
