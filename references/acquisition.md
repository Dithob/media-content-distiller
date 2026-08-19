# 字幕获取参考

> 本文件中的 `scripts/...` 命令默认从 skill 仓库根目录执行；安装后请将 `scripts/` 替换为实际安装目录，或先 `cd` 到 skill 目录。

## Node.js CLI path

本 skill 自带的 Node.js CLI 是正常入口。它不检测、不调用其他 skill 或其他命令，
直接使用 Node.js 内置 `fetch` 调用 BibiGPT API。公开 URL 按以下顺序执行：

1. 解析当前项目的 API Token；
2. `GET /v1/me` 做授权和余额预检；
3. `GET /v1/getSubtitle` 获取字幕；
4. 标准化字幕、校验时间轴并写入 `media-artifacts/`。

```bash
media-content-distiller subtitle \
  --url "https://example.com/video" \
  --output-dir ./media-artifacts
```

CLI 只使用 BibiGPT 的字幕接口，不调用 `/v1/summarize`、
`/v1/summarizeWithConfig` 或 `/v1/summarizeByChapter`。总结、章节结构和学习文档由
Codex 在字幕产物上完成。

## API path

Node.js CLI 和旧 Python 入口使用相同的 BibiGPT API 逻辑。按以下顺序从当前项目发现凭证：

1. 显式 `--registry`；
2. 显式 `--token-env NAME`；
3. 进程环境变量 `BIBI_API_TOKEN`；
4. 当前项目 `.env` 的 `BIBI_API_TOKEN`；
5. 进程环境变量或 `.env` 的 `BIBIGPT_TOKEN_REGISTRY` 指针；
6. 当前项目根 `accounts.json`；
7. 兼容旧名 `accounts-tokens.json`。

```bash
media-content-distiller subtitle \
  --input "https://example.com/video" \
  --output-dir ./media-artifacts
```

旧 Python 兼容入口：

```bash
python3 scripts/acquire_subtitle.py subtitle \
  --input "https://example.com/video" \
  --output-dir ./media-artifacts
```

API 字幕获取只对公开 URL 生效。本地媒体文件不会被自动上传，也不会被当作 URL
发送给 `/v1/getSubtitle`；传入本地路径时应明确提示用户改用公开可访问的媒体 URL。

已有账号文件也可以显式指定：

```bash
python3 scripts/acquire_subtitle.py subtitle \
  --input "https://example.com/video" \
  --registry ./accounts.json \
  --output-dir ./media-artifacts
```

字幕任务会先调用 `/v1/me` 做授权和余额预检，再调用：

```text
GET https://api.bibigpt.co/api/v1/getSubtitle
```

请求头：

```text
Authorization: Bearer <user-authorized-token>
x-client-type: media-content-distiller
```

`remainingMinutes <= 0`、401、402/403、429 等情况会停止并报告，不自动切换账号或轮换 Token。Ego Lite 仅在用户明确要求网页验证，或 API 不可用且用户允许兜底时使用。

## Output layout

```text
media-artifacts/
├── README.md
├── <主产物标题>.md
└── <source-id>/
    ├── README.md
    ├── raw-subtitle.json
    ├── metadata.json
    ├── transcript.md
    └── status.json
```

`<source-id>` 对 Bilibili 为 BV 号；主产物由 Codex 根据用户目标生成，使用清理后的标题，不拼接技术后缀。

## First-use setup and repair

交互式使用时，客户端可以在当前任务内通过 PTY 隐藏输入 Token，创建或绑定项目级账号文件，并继续字幕请求；不要要求用户把 Token 粘贴到聊天、命令行参数或普通文本文件中。

首次配置有三种方式：

- 环境变量：`export BIBI_API_TOKEN="<你的Token>"`；
- 项目 `.env`：写入 `BIBI_API_TOKEN=<你的Token>`，或写 `BIBIGPT_TOKEN_REGISTRY=./accounts.json`；
- 批量导入：

  ```bash
  media-content-distiller import \
    --registry ./accounts.json \
    --input ./tokens.txt \
    --acknowledge-plaintext-token-storage
  ```

没有 TTY 的 CI/批处理环境可使用：

```bash
media-content-distiller repair \
  --registry ./accounts.json \
  --env-file ./.env \
  --acknowledge-plaintext-token-storage
```

已有账号文件只绑定当前项目：

```bash
media-content-distiller bind \
  --registry ./accounts.json \
  --env-file ./.env
```

账号文件和 `.env` 会尽力收紧为 `0600`；Token 不写入 skill、日志、产物或文档。
旧 Python registry 入口仍保留给已有自动化：
`python3 scripts/token_registry.py setup|repair|bind|import ...`。

## Selection and safety

- 账号按 `accounts` 数组顺序选择第一个有 Token 且缓存余额大于 0 的槽位；
- `remaining_minutes: null` 表示余额未知，新导入 Token 会先被选中并通过 `/v1/me` 预检；
- 直接环境变量或 `.env` 单 Token 只作为当前调用凭证，不自动写入账号文件；
- 401、402/403、429 时停止，不自动轮询、轮换或换账号；
- 不自动注册账号、收集 Cookie、处理验证码或绕过额度。

## Input notes

- URL：Bilibili、YouTube、TikTok/Douyin、小红书、播客和公开媒体 URL；
- 本地文件：API 模式不直接上传；明确提示用户提供公开可访问的媒体 URL；
- 需要 `audioLanguage`、speaker identification、`transcribeProvider` 或 `whisperPrompt` 时，只在用户明确指定后传递。

## Response shapes

客户端和本地渲染器兼容：

- BibiGPT `detail.subtitlesArray`；
- 通用 `subtitles[]`；
- Bilibili 字幕资源 `body[]`，字段通常是 `from`、`to`、`content`。

原始响应先脱敏保存，再交给本地标准化脚本；不要依赖某一个网页内部接口或 tRPC 字段。
