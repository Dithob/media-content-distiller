# 字幕获取参考

## 选择方式

单个公开 URL 的一次性任务，优先直接使用 `curl`；这样不需要为一次请求启动 skill
脚本。需要项目级 Token 探测、批处理、离线渲染或标准副产物时，使用本 skill 的
Node.js CLI。

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

公开 URL 固定执行：

1. `GET /v1/me` 检查授权和余额；
2. `GET /v1/getSubtitle` 获取字幕；
3. 标准化 `subtitlesArray`、`subtitles[]` 或 `body[]`；
4. 校验时间轴；
5. 需要留档时写入来源副产物目录。

CLI 只把上述机械步骤和 Token registry 做成可复用命令；Python 入口只是旧调用方的
转发器。不调用 BibiGPT summary endpoints，也不调用其他 skill 或命令。

## 输入边界

- 支持 Bilibili、YouTube、TikTok/Douyin、小红书、播客和其他公开媒体 URL；
- 当前 API 只接受公开 URL，本地音视频文件在网络请求前安全失败；
- 已有本地字幕 JSON 可以离线 `normalize` / `render`；
- `audioLanguage`、speaker identification、`transcribeProvider` 和 `whisperPrompt` 只有用户明确指定时才传递。

## 产物

```text
media-artifacts/
├── README.md
├── <Codex 主稿>.md
└── <source-id>/
    ├── README.md
    ├── raw-subtitle.json
    ├── metadata.json
    ├── transcript.md
    ├── status.json
    ├── evidence.md
    ├── timeline.md
    └── boundaries.md
```

字幕命令只写 `raw-subtitle.json`、`metadata.json`、`transcript.md`、`status.json` 和导航 README；`evidence.md`、`timeline.md`、`boundaries.md` 由总结任务按需写入。主稿命名由任务决定，可用：

```bash
media-content-distiller name \
  --metadata ./media-artifacts/source-id/metadata.json \
  --purpose "整理为操作手册"
```

不要将完整时间轴回查、逐条证据和补充边界塞进主稿。

## 兼容响应

- BibiGPT `detail.subtitlesArray`；
- 通用 `subtitles[]`；
- Bilibili `body[]`，常见字段为 `from`、`to`、`content`。

原始响应写盘前脱敏；时间轴必须有限、非负、`start <= end` 且不倒退。
