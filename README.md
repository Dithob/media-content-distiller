# Media Content Distiller

包名与 skill slug：`media-content-distiller`

[English](README.en.md) | 中文

一个轻量的音视频字幕与内容蒸馏 skill：一次性 URL 任务直接请求 BibiGPT 字幕 API；需要可复用配置、批处理、离线渲染或标准产物时，再使用本 skill 自带的 Node.js CLI，由 Codex 按需求写摘要、详细总结、结构梳理、操作手册、学习笔记或问答。

> BibiGPT 只作为字幕服务提供方；不依赖其他 skill，不调用 BibiGPT 总结接口。

## 核心变化

- **单次任务直接 API**：简单 URL 任务用 `curl` 即可，不必为一次调用启动多层脚本。
- **Node.js CLI 负责可复用工作**：不需要 Python，不需要第三方 npm 包；Python 文件只做旧命令兼容转发。
- **初始化时全量探测 Token**：`setup`、`import`、`add` 默认逐个请求 `/v1/me`，验证授权状态、剩余额度、套餐和错误状态。
- **主稿与副产物分离**：字幕获取只写来源副产物；Codex 根据用户需求命名并写入主稿，时间轴回查、证据说明和补充边界放在来源目录。
- **本地媒体不自动上传**：当前 API 只接受公开 URL；已有本地字幕 JSON 可以离线处理。

## 安装

### 安装 skill

```bash
npx skills add Dithob/media-content-distiller --skill media-content-distiller -g -y
```

### 安装 CLI

需要 Node.js 18+：

```bash
git clone https://github.com/Dithob/media-content-distiller.git
cd media-content-distiller
npm install --global .
media-content-distiller --help
```

不想全局安装时：

```bash
./bin/media-content-distiller --help
```

## 快速使用

### 1. 一次性任务直接请求 API

如果只是处理一个 URL，可以直接使用 `curl`，不必安装 CLI：

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

先解析 `/v1/me` 和 `/v1/getSubtitle` 返回的 JSON，再由 Codex 整理内容。不要调用
BibiGPT 总结接口，也不要把 Token 直接写到 curl 参数中。

### 2. 用 CLI 获取字幕并生成副产物

```bash
media-content-distiller subtitle \
  --url "https://example.com/video" \
  --output-dir ./media-artifacts \
  --purpose "总结笔记"
```

命令依次执行 `/v1/me` → `/v1/getSubtitle`，标准化字幕并校验时间轴。它会返回建议的主稿文件名，例如：

- 总结笔记：`媒体标题摘要.md`
- 详细总结：`媒体标题详细总结.md`
- 操作手册：`软件名称操作手册.md`
- 学习文档：`媒体标题学习笔记.md`

### 3. 初始化并全量检查 Token

单 Token 交互式初始化：

```bash
media-content-distiller setup \
  --registry ./accounts.json \
  --env-file ./.env \
  --acknowledge-plaintext-token-storage
```

Token 会通过隐藏输入读取。初始化完成后，registry 中**所有已配置 Token**都会被逐个探测，并保存 `usable`、`invalid`、`forbidden`、`quota_exhausted`、`rate_limited` 或 `unavailable` 状态，以及剩余分钟数和套餐信息。

批量导入：

```bash
media-content-distiller import \
  --registry ./accounts.json \
  --env-file ./.env \
  --input ./tokens.txt \
  --acknowledge-plaintext-token-storage
```

重新检查：

```bash
media-content-distiller probe --registry ./accounts.json
media-content-distiller list --registry ./accounts.json
```

`check` 只检查本地配置，不发网络请求；`probe` 才会实际验证 Token。

非交互式安全输入：

```bash
printf '%s\n%s\n' "$TOKEN_A" "$TOKEN_B" | \
  media-content-distiller setup \
  --registry ./accounts.json \
  --env-file ./.env \
  --token-stdin \
  --acknowledge-plaintext-token-storage
```

不要把真实 Token 写进聊天、命令历史、Git、日志或产物。账号文件和 `.env` 会尽力设置为 `0600`，并被 `.gitignore` 忽略。

### 4. 让 CLI 建议主稿文件名

```bash
media-content-distiller name \
  --metadata ./media-artifacts/<source-id>/metadata.json \
  --purpose "整理为操作手册"
```

### 5. 本地字幕 JSON 离线处理

```bash
media-content-distiller normalize --input ./raw-subtitle.json
media-content-distiller render \
  --subtitle ./raw-subtitle.json \
  --metadata ./metadata.json \
  --out-dir ./media-artifacts/source-id
```

### 6. 批量获取字幕

```bash
media-content-distiller batch \
  --input ./videos.jsonl \
  --output-dir ./media-artifacts
```

批处理只获取字幕；后续总结、比较和学习文档仍由 Codex 完成。

### 7. Python 旧入口

旧自动化可以继续执行：

```bash
python3 scripts/acquire_subtitle.py subtitle --input "https://example.com/video"
python3 scripts/token_registry.py probe --registry ./accounts.json
python3 scripts/render_transcript.py \
  --subtitle ./raw-subtitle.json \
  --out-dir ./media-artifacts/source-id
```

这些文件只是转发器，最终仍使用同一套 Node.js 实现。没有 Node.js 时，Python 兼容入口也不会工作；新用户不要为本 skill 单独搭 Python 环境。

## 产物布局

```text
media-artifacts/
├── README.md                         # 来源索引与建议主稿名
├── <主稿文件>.md                     # Codex 按任务写入
└── <source-id>/
    ├── README.md                     # 副产物导航
    ├── raw-subtitle.json             # 脱敏字幕响应
    ├── metadata.json                 # 标题、来源、时长、额度快照等
    ├── transcript.md                 # 时间轴转录
    ├── status.json                   # 获取状态
    ├── evidence.md                   # 可选：证据说明
    ├── timeline.md                   # 可选：时间轴回查
    └── boundaries.md                 # 可选：补充边界/无法确认项
```

主稿只保留用户真正需要阅读的内容；一次性 `curl` 任务可以不保存原始 JSON，但只要生成文件，就应把时间轴、逐条证据、覆盖判断、背景补充和无法确认项放在 `<source-id>/` 副产物中。主稿末尾只保留简短的副产物导航。

## API 与安全边界

- 正常 API 链路固定为 `GET /v1/me` → `GET /v1/getSubtitle`。
- 不调用 `/v1/summarize`、`/v1/summarizeWithConfig` 或 `/v1/summarizeByChapter`。
- 本地媒体路径会在 Token 解析和网络请求前失败，不会自动上传。
- 401/403、额度为零、429、5xx、字幕为空或时间轴异常时停止，不伪造完成。
- 不自动注册账号、收集 Cookie、轮换 Token 或绕过额度/风控。
- raw、metadata、status、日志、主稿和 Git 中不得出现 Token、Cookie、Authorization 或完整认证参数。

## 目录

```text
media-content-distiller/
├── SKILL.md
├── agents/openai.yaml
├── bin/                     # Node.js CLI 入口
├── lib/                     # CLI 核心实现
├── scripts/                 # Python 兼容转发器和验证脚本
├── references/              # API、Token、产物和证据说明
├── tests/                   # 离线测试
├── package.json
├── README.md
└── README.en.md
```

## 发布前检查

```bash
npm run test:cli
node scripts/verify_cli.mjs
PYTHONPYCACHEPREFIX=/tmp/media-content-distiller-pycache \
  python3 scripts/verify_skill.py
PYTHONPYCACHEPREFIX=/tmp/media-content-distiller-pycache \
  python3 -m unittest discover -s tests -v
git diff --check
```

离线检查只验证本地代码和安全边界，不代表真实 BibiGPT Token、额度或当前服务已联调。

## License

MIT，见 [LICENSE](LICENSE)。
