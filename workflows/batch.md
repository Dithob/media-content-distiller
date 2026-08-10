# 批量字幕获取与后处理

> 本文件中的 `scripts/...` 命令默认从 skill 仓库根目录执行；安装后请将 `scripts/` 替换为实际安装目录，或先 `cd` 到 skill 目录。

## Triggers

“批量提取字幕”“批量总结”“比较这些视频”“处理这些链接”。

## Steps

1. 读取 JSONL；每行可以是 URL 字符串或 `{"input": "..."}`。
2. 按媒体来源去重，默认串行执行；使用项目账号文件时按账号槽位顺序选第一个可用 Token，不做轮询。
3. 每个输入只走字幕链路，在对应的短来源 ID 文件夹中保存 `raw-subtitle.json`、`metadata.json`、`transcript.md` 和 `status.json`，并更新 `media-artifacts/README.md`。
4. 已完成项可复用缓存；401、402/403、429 或额度错误停止当前批次并报告，不自动切换账号。
5. 字幕全部准备好后，再按用户要求由 Codex 做批量快速总结、详细总结或横向比较。

没有账号文件时先初始化或绑定，不要把 Token 放入 skill：

```bash
python3 scripts/token_registry.py setup \
  --registry ./accounts.json \
  --env-file ./.env \
  --acknowledge-plaintext-token-storage
```

已有账号文件时：

```bash
python3 scripts/acquire_subtitle.py batch \
  --input ./videos.jsonl \
  --output-dir ./media-artifacts \
  --registry ./accounts.json
```

批处理 manifest 记录字幕阶段状态，不把“已拿到字幕”误记为“已完成总结”。
