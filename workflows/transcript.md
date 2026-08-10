# 字幕与时间轴转录

> 本文件中的 `scripts/...` 命令默认从 skill 仓库根目录执行；安装后请将 `scripts/` 替换为实际安装目录，或先 `cd` 到 skill 目录。

## Triggers

“提取字幕”“转录”“给我原文”“需要时间戳”“保留完整字幕”。

## Steps

1. 先确认 URL 或本地文件；已有 raw JSON 时直接复用，不重新请求。
2. 优先运行：

   ```bash
   bibi summarize "<INPUT>" --subtitle --json
   ```

3. 没有 CLI 时运行：

   ```bash
   python3 scripts/acquire_subtitle.py subtitle \
     --input "<URL>" \
     --output-dir ./media-artifacts
   ```

4. 校验字幕结构和时间轴；记录 cue 数、首尾时间、视频时长和覆盖判断。
5. 默认每 10 条 cue 合并为一个时间段；cue 之间直接换行，不插入伪文本。
6. 用户明确要求逐句时使用 `--sentences-per-group 1`。
7. 用户需要其他风格时传入 `--sentence-separator '|'`、`--sentence-separator space` 或自定义字符串。

## Output

- `media-artifacts/<source-id>/raw-subtitle.json`
- `media-artifacts/<source-id>/metadata.json`
- `media-artifacts/<source-id>/transcript.md`
- `media-artifacts/<source-id>/status.json`
- `media-artifacts/README.md`

该 workflow 只负责字幕底稿和转录，不生成 BibiGPT 总结，也不替用户判断内容价值。
