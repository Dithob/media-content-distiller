---
name: media-content-distiller
description: "Use when the user provides supported audio/video URLs or local media files and wants subtitles, a transcript, a quick or detailed summary, a structured outline, a learning note, or source-faithful content analysis. Use the skill-owned Node.js CLI for API Token setup, BibiGPT subtitle acquisition, normalization, rendering, and batch processing without Python; keep the Python scripts only for compatibility. For local media files, do not upload them automatically: require a public media URL or process an existing local subtitle JSON artifact. All synthesis is performed by Codex from normalized subtitles."
---

# Media Content Distiller

## Core contract

本 skill 的主功能是获取并整理字幕，不是调用 BibiGPT 的总结接口。

```text
公开音视频 URL
  → media-content-distiller CLI（Node.js >= 18）
      → 解析项目 Token
      → GET /v1/me
      → GET /v1/getSubtitle
      → 标准化、校验时间轴、写入 media-artifacts/
  → Codex 按用户需求完成转录、总结、解释、问答和学习文档
```

`media-content-distiller` 自带完整 Node.js CLI。它使用 Node.js 内置模块直接访问
BibiGPT 的字幕 API，不检测、不调用其他 skill，也不要求 Python。Python 脚本继续保留
为旧调用方、旧自动化和兼容验证入口，但不是新用户的运行时前置条件。

### Non-negotiable boundaries

- 只把 BibiGPT 当作字幕提供方；正常内容任务只调用 `/v1/me` 和 `/v1/getSubtitle`。
- 不调用 `/v1/summarize`、`/v1/summarizeWithConfig` 或 `/v1/summarizeByChapter`。
- 不调用其他 skill 的 CLI，不复制其他 skill 的工作流。
- BibiGPT API 当前只接受公开媒体 URL；本地媒体文件不自动上传，不伪造 URL，也不调用
  其他程序代为处理。收到本地媒体时，明确要求用户提供公开可访问的媒体 URL。
- 已有本地字幕 JSON 可以离线使用 `normalize` 和 `render`，无需网络或 Token。

“快速总结”“详细总结”“章节结构”“学习文档”都是字幕获取之后由 Codex 完成的
输出工作，不是 BibiGPT API 模式。

## Use this skill when

- 用户提供 Bilibili、YouTube、TikTok/Douyin、小红书、播客或其他公开音视频 URL；
- 用户提供本地音频或视频文件，并希望提取字幕或整理内容；
- 用户说“提取字幕”“转录”“总结视频”“详细梳理”“整理成学习文档”或“内容问答”；
- 用户需要基于同一份字幕做快速摘要、详细总结、结构化梳理、学习判断或问答；
- 用户需要批量取得多条公开媒体 URL 的字幕，再由 Codex 做比较或汇总；
- 用户已有本地字幕 JSON，只想标准化、检查时间轴或渲染时间戳转录。

如果用户只提供裸 URL 且没有说明用途，默认：获取字幕并给出简洁的内容概览。
不要调用 BibiGPT 总结接口。

## Intent routing

| 用户意图 | 先做什么 | 之后由 Codex 输出什么 |
|---|---|---|
| 提取字幕 / 转录 | 获取并校验字幕 | 时间轴转录，可选逐 cue 或分组 |
| 快速总结 | 获取字幕 | 一句话结论、关键点、适合人群、明显限制 |
| 详细总结 | 获取字幕 | 按内容顺序完整梳理观点、案例、方法、限制和结论 |
| 章节 / 结构总结 | 获取字幕 | 根据主题转折和时间轴归纳章节；不得称为官方章节 |
| 学习文档 | 获取字幕 | 详细梳理、前置知识、实操价值、内容密度、跳读建议 |
| 内容问答 | 获取字幕 | 只基于字幕回答，尽量附时间段；不足处明确说无法确认 |
| 多视频比较 | 分别获取字幕 | 再由 Codex 做横向比较，不把一个视频的观点移给另一个视频 |
| 批量处理 | 串行获取字幕 | 保存每个视频状态，之后按用户要求批量总结或比较 |
| 本地字幕 JSON | `normalize` / `render` | 离线标准化或时间轴转录 |

详细步骤见 `workflows/`：

- `transcript.md`：字幕与时间轴转录
- `quick-summary.md`：快速总结
- `detailed-summary.md`：详细总结
- `structured-summary.md`：基于字幕的结构/章节总结
- `learning-note.md`：学习文档
- `batch.md`：批量字幕获取与后处理

## CLI runtime and credential checks

安装后优先使用本 skill 自带的 CLI：

```bash
media-content-distiller --help
media-content-distiller check --env-file ./.env
media-content-distiller me --env-file ./.env
media-content-distiller subtitle \
  --url "https://example.com/video" \
  --output-dir ./media-artifacts
```

如果尚未安装为全局命令，可以直接运行：

```bash
./bin/media-content-distiller --help
```

CLI 需要 Node.js 18 或更高版本，只使用 Node.js 内置模块，不需要 Python 或第三方
npm 包。`python3 scripts/...` 仍可用于旧调用方、旧渲染流程和仓库验证，但不是
网络字幕任务的必需运行时。

### Public URL acquisition

对公开 URL，CLI 固定执行：

1. 解析 Token；
2. `GET /v1/me` 做授权和余额预检；
3. 检查 `remainingMinutes`，余额耗尽时停止；
4. `GET /v1/getSubtitle` 获取字幕；
5. 标准化 `subtitlesArray`、`subtitles[]` 或 Bilibili `body[]`；
6. 校验时间轴并写入标准产物布局。

请求只使用本 skill 自己的 API client。不会调用 summary endpoints，也不会把
stdout/stderr 当作其他 CLI 的协议。

### Local media acquisition

本地音频或视频路径不能直接发送给当前 URL-only API。遇到本地媒体时：

1. 先明确报告“当前 API 只接受公开 URL，本地文件不会自动上传”；
2. 不解析 Token，不发网络请求，不生成伪造的完成状态；
3. 请用户提供公开可访问的媒体 URL；
4. 如果用户已有本地字幕 JSON，改走 `normalize`/`render` 离线流程。

## 凭证可用性检查

开始公开 URL 网络任务前，确认 BibiGPT API 凭证来源。CLI 和 Python 兼容入口按
以下顺序处理：

1. 显式 `--registry`；
2. 显式 `--token-env NAME`；
3. 进程环境变量 `BIBI_API_TOKEN`；
4. 当前项目 `.env` 中的 `BIBI_API_TOKEN`；
5. 进程环境变量或当前项目 `.env` 中的 `BIBIGPT_TOKEN_REGISTRY` 指向的账号文件；
6. 当前项目根目录 `accounts.json`；
7. 兼容旧项目的 `accounts-tokens.json`。

`accounts.json` 是推荐的新名称，`accounts-tokens.json` 只用于兼容迁移。显式参数
优先于自动发现；不会从 skill 目录读取或写入 Token。

`remainingMinutes <= 0` 或 401/402/403/429 等错误会停止并报告；不自动换号、
轮换 Token 或绕过额度。Ego Lite 仅在用户明确要求网页验证，或明确允许合法 API
不可用时的可见兜底时使用，默认不启动。

## 首次配置

Token 只能由用户本人或明确授权账户提供。优先使用项目级配置，不要把 Token 发到
聊天、普通日志、Git 或 skill 文件中。

### 方式 A：进程环境变量

```bash
export BIBI_API_TOKEN="<你的Token>"
```

```powershell
$env:BIBI_API_TOKEN="<你的Token>"
```

### 方式 B：项目 `.env`

单 Token：

```dotenv
BIBI_API_TOKEN=<你的Token>
```

多 Token 或已有账号文件：

```dotenv
BIBIGPT_TOKEN_REGISTRY=./accounts.json
```

`.env` 只保存单 Token 或账号文件路径；账号文件和 `.env` 应加入项目 `.gitignore`，
工具写入时会尽力收紧为 `0600`。

### 方式 C：使用内置 Node.js CLI 初始化 registry

```bash
media-content-distiller setup \
  --registry ./accounts.json \
  --env-file ./.env \
  --acknowledge-plaintext-token-storage
```

CLI 会通过隐藏输入读取 Token；Token 不会回显。非交互环境可以使用安全 stdin：

```bash
printf '%s' "$BIBI_API_TOKEN" | \
  media-content-distiller setup \
  --registry ./accounts.json \
  --env-file ./.env \
  --token-stdin \
  --acknowledge-plaintext-token-storage
```

不要把真实 Token 写入 shell history、普通脚本、日志或仓库。已有账号文件只绑定路径：

```bash
media-content-distiller bind \
  --registry ./accounts.json \
  --env-file ./.env
```

### 方式 D：批量导入到 `accounts.json`

准备换行分隔文本文件，每行一个 Token，或准备包含 `accounts` 数组的 JSON 文件：

```bash
media-content-distiller import \
  --registry ./accounts.json \
  --input ./tokens.txt \
  --acknowledge-plaintext-token-storage
```

批量导入会自动去重、复用空槽位并把账号文件路径写入项目 `.env`；不会注册账号、
验证验证码、收集 Cookie 或自动轮换 Token。

Python 兼容 registry 入口仍可运行：

```bash
python3 scripts/token_registry.py repair ...
python3 scripts/token_registry.py import ...
```

## Acquisition modes

按以下顺序选择字幕获取方式：

1. **已有本地字幕 JSON**：使用 CLI 的 `normalize` / `render`，不重新请求网络；
2. **公开媒体 URL**：使用 CLI 自有 API client 的 `/v1/me` + `/v1/getSubtitle`；
3. **本地音视频文件**：安全停止并要求公开 URL，不自动上传；
4. **Ego Lite 兜底**：仅在 API 不可用、响应结构不兼容，或用户明确要求网页验证时使用。

支持的公开输入包括：

- Bilibili、YouTube、TikTok/Douyin、小红书、播客；
- 公开可下载的 `.mp3`、`.mp4`、`.wav`、`.m4a` 等媒体 URL。

## Synthesis policy

字幕是视频内容的事实底稿。获取字幕后，根据用户的目标和个人习惯决定总结颗粒度，
不要被固定模板替代判断。

证据优先级：

1. **字幕和元数据**：支持“视频明确说了什么”；
2. **用户已确认的偏好、项目记忆和本地知识库**：决定输出风格、重点和关联背景；
3. **模型通识**：用于解释术语、补足必要前置知识；
4. **联网搜索**：只在用户要求、内容涉及当前变化、术语不确定或需要外部核验时使用；
   必须把外部信息标为背景，不得伪装成视频原话。

最终内容要区分：

- **字幕已验证**：字幕或元数据直接支持；
- **背景补充**：来自知识库、模型知识或联网资料；
- **当前任务判断**：Codex 根据用户目标做出的分析；
- **无法确认**：字幕缺失、含混或没有足够证据。

## Artifacts

默认把主产物放在 `media-artifacts/` 根目录，把字幕获取阶段的副产物放进来源 ID
文件夹。Bilibili 使用 BV 号作为来源 ID；其他来源使用稳定的短 ID。

```text
media-artifacts/
├── README.md               # 主产物索引
├── <标题>.md               # 主产物：总结、说明书或学习文档
└── <source-id>/
    ├── README.md           # 副产物导航
    ├── raw-subtitle.json   # 脱敏后的原始 API 响应
    ├── metadata.json       # 标题、作者、时长、来源、获取方式、覆盖信息
    ├── transcript.md       # 可回查的时间轴转录
    └── status.json         # 字幕获取状态和非敏感响应摘要
```

主产物命名规则：

- 默认使用视频标题或任务标题的清理版；
- 不把技术后缀拼进主产物名称；
- 不把 BV 号重复拼到主产物名称；
- 若同名主产物已存在，追加短来源 ID，避免覆盖；
- 生成主产物后更新 `media-artifacts/README.md`；
- 主产物文末增加 `## 副产物导航`，链接到 `<source-id>/README.md`。

总结由当前任务按需生成，不调用或生成 BibiGPT 的总结结果文件。完整 cue 保留在
脱敏后的 `raw-subtitle.json` 中，分组转录不冒充官方逐句原文。

## Transcript formatting

默认每 10 条字幕 cue 合并为一个时间段，但句子不能挤成一整串。每个 cue 默认直接
换行分隔，不插入未请求的伪文本。需要逐 cue 对照时使用：

```bash
media-content-distiller render \
  --subtitle ./raw-subtitle.json \
  --out-dir ./media-artifacts/source-id \
  --sentences-per-group 1
```

也可以使用 `--sentence-separator '|'`、`space` 或自定义字符串。

## Credentials and safety

- 使用账号文件时先 `/v1/me` 预检并回写非敏感余额快照；直接环境变量或 `.env` 单
  Token 也会先预检，但不会自动写入账号文件；
- Token 只能来自用户本人或明确授权账户的环境变量、`.env`、项目级 registry、系统
  密钥链或显式环境变量；
- 不在输出、日志、Markdown、Git 或截图中写入 Token、Cookie、Authorization 或完整
  认证 URL；
- 不自动注册账号、收集 Cookie、轮换 Token 或绕过额度、付费、频控和风控；
- API 错误按 401、402/403、404、429、5xx 和字幕缺失分别报告，不把失败记成完成；
- API 成功时不启动 Ego Lite，也不为了“验证一下”重复访问网页。

## Validation gates

交付前检查：

- 输入来源、平台、标题、作者、时长可追溯；
- 凭证来源已确认，或已明确报告未找到凭证且未发起网络请求；
- 识别到 `subtitlesArray`、`subtitles[]` 或 Bilibili `body[]` 至少一种结构；
- 每条 `start <= end`，时间不倒退；
- 记录 cue 数、分组数、首条时间、末条时间和覆盖判断；
- 字幕为空或时间轴异常时停止，不称为完整转录；
- 默认转录中不得出现 `〔句间分隔〕` 或其他未请求的伪分隔文本；
- 主产物位于 `media-artifacts/` 根目录，副产物位于短来源 ID 文件夹；
- `media-artifacts/README.md` 能指向主产物和对应副产物；
- 未输出 Token、Cookie、请求头或认证参数；
- 文档链接保留原始媒体链接。

## Related skills

- `ego-browser`：网页登录、可见验收和 API 不可用时的字幕兜底；
- `share-transcript-distiller`：已有字幕后进一步蒸馏成知识笔记；
- `daily-note-kb-distiller`：用户要求归档到知识库时使用。

旧版 `summary` / `hybrid` 命令和 BibiGPT 总结产物不再是正常链路；已有旧产物仍
可作为本地输入，但新的内容任务统一遵循“先字幕、后由 Codex 总结”。
