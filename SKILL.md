---
name: media-content-distiller
description: "Use when a user provides a public audio/video URL or subtitle JSON and wants a transcript, summary, structured outline, operation manual, learning note, or source-faithful analysis. For one-off URL tasks, call the BibiGPT subtitle API directly with curl; use this skill's Node.js CLI only for Token setup/probing, repeatable batch work, offline rendering, and artifact layout. Do not upload local media automatically. Keep timelines, evidence, and boundaries in source sidecars instead of the main document."
---

# Media Content Distiller

字幕获取和内容整理分开处理：

```text
公开媒体 URL
  → BibiGPT /v1/me
  → BibiGPT /v1/getSubtitle
  → Codex 根据字幕写主稿
```

BibiGPT 只提供字幕。总结、章节、操作手册、学习笔记和问答都由 Codex 完成。
不要调用 BibiGPT 的总结接口，也不要调用其他 skill。

## 默认选择：单个 URL 直接用 curl

对于一次性的 URL 任务，不要为了获取一份字幕启动一串脚本；直接调用 API，并在当前任务
中解析 JSON。Token 不要写进命令参数、聊天、日志或文件名。为了避免 Token 出现在
`curl` 的进程参数中，可使用临时 curl 配置文件：

```bash
read -r -s BIBI_API_TOKEN
export BIBI_API_TOKEN
printf '\n'

umask 077
cfg="$(mktemp)"
trap 'rm -f "$cfg"' EXIT
printf 'header = "Authorization: Bearer %s"\nheader = "Accept: application/json"\n' \
  "$BIBI_API_TOKEN" >"$cfg"

curl --silent --show-error --fail-with-body \
  --config "$cfg" \
  "${BIBIGPT_BASE:-https://api.bibigpt.co/api}/v1/me"

curl --silent --show-error --fail-with-body -G \
  --config "$cfg" \
  --data-urlencode "url=$MEDIA_URL" \
  "${BIBIGPT_BASE:-https://api.bibigpt.co/api}/v1/getSubtitle"
```

先检查 `/v1/me` 的授权和剩余额度，再调用 `/v1/getSubtitle`。如果 API 返回 401/402/403、
429、额度为零、字幕为空或时间轴异常，停止并明确报告，不能伪造完成。

需要可复用的本地文件、批处理或标准副产物时，再使用 CLI：

```bash
media-content-distiller subtitle \
  --url "$MEDIA_URL" \
  --output-dir ./media-artifacts \
  --purpose "总结笔记"
```

CLI 使用 Node.js 18+ 内置 `fetch`，不依赖 Python 或第三方 npm 包。它只负责重复性、
安全性较高的机械工作；普通内容任务不需要先运行 CLI。Python 文件若存在，只是旧入口
兼容层，不是本 skill 的运行时依赖。

## Token 初始化和全量探测

Token 只能由用户本人或明确授权账户提供。推荐使用项目级 registry：

```bash
media-content-distiller setup \
  --registry ./accounts.json \
  --env-file ./.env \
  --acknowledge-plaintext-token-storage
```

`setup`、`import` 和 `add` 写入 Token 后，默认会对 registry 中**所有已配置 Token**
逐个调用 `/v1/me`，保存不含 Token 的状态快照：

- `usable`：请求成功且额度大于零，或服务端没有返回额度字段；
- `quota_exhausted`：额度为零；
- `invalid` / `forbidden` / `rate_limited` / `unavailable`：对应错误状态；
- `remaining_minutes`、`plan`、HTTP 状态、检查时间和脱敏错误。

```bash
media-content-distiller import \
  --registry ./accounts.json \
  --env-file ./.env \
  --input ./tokens.txt \
  --acknowledge-plaintext-token-storage

media-content-distiller probe --registry ./accounts.json
media-content-distiller list --registry ./accounts.json
```

只有明确要暂时离线写入时才使用 `--skip-probe`。Token 文件和 `.env` 应为 `0600`，
不要提交到 Git。单 Token 任务也可以只设置 `BIBI_API_TOKEN`，不必初始化 registry。

## 输入边界

- 支持公开的 Bilibili、YouTube、TikTok/Douyin、小红书、播客及其他媒体 URL；
- 当前 API 只接受公开 URL；本地音视频文件不自动上传，直接要求公开 URL；
- 已有本地字幕 JSON 可以离线使用：

  ```bash
  media-content-distiller normalize --input ./raw-subtitle.json
  media-content-distiller render \
    --subtitle ./raw-subtitle.json \
    --metadata ./metadata.json \
    --out-dir ./media-artifacts/<source-id>
  ```

- 不调用 `/v1/summarize`、`/v1/summarizeWithConfig` 或 `/v1/summarizeByChapter`。

## 主稿命名与副产物

根据用户的目标拟定主稿文件名，不要机械使用 `summary.md`：

- 总结笔记：`<媒体标题>摘要.md`；
- 详细总结：`<媒体标题>详细总结.md`；
- 结构梳理：`<媒体标题>结构梳理.md`；
- 整理为操作手册：`<软件或主题>操作手册.md`；
- 学习文档：`<媒体标题>学习笔记.md`；
- 时间轴转录：`<媒体标题>时间轴转录.md`。

标题过于泛化时，结合字幕内容提炼主题；操作手册优先使用软件、产品或主题名。
CLI 可以给候选名：

```bash
media-content-distiller name \
  --metadata ./media-artifacts/<source-id>/metadata.json \
  --purpose "整理为操作手册" \
  --subject "软件名称"
```

主稿只放用户真正要读的内容。完整时间轴、逐条证据、覆盖判断、背景补充和无法确认项
放到来源副产物目录：

```text
media-artifacts/
├── <主稿文件>.md
└── <source-id>/
    ├── README.md
    ├── raw-subtitle.json
    ├── metadata.json
    ├── transcript.md
    ├── timeline.md
    ├── evidence.md
    └── boundaries.md
```

主稿末尾最多保留一个副产物导航链接；不要把“时间轴回查”“证据说明”“补充边界”
整段复制进主稿。`timeline.md`、`evidence.md`、`boundaries.md` 按任务需要生成。

## 内容与证据规则

- 字幕和元数据支持“媒体明确说了什么”；
- 模型知识、项目资料或联网信息必须标为背景，不冒充媒体原话；
- 结构化章节要标为“基于字幕推断”，不能称为官方章节；
- 无法由字幕确认的内容写入 `boundaries.md`，主稿中简洁说明即可；
- 需要当前版本、价格、法规或用户明确要求核验时才联网搜索。

按需阅读：

- `references/acquisition.md`：curl/API 输入和错误处理；
- `references/token-registry.md`：registry 字段、探测和安全边界；
- `references/output.md`：主稿、副产物和证据标签。
