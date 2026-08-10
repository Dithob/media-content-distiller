---
name: media-content-distiller
description: "Use when the user provides one or more supported audio/video URLs or local media files and wants subtitles, a transcript, a quick or detailed summary, a structured outline, a learning note, or source-faithful content analysis. The primary service operation is BibiGPT subtitle acquisition; all synthesis is performed by Codex from normalized subtitles. Supports Bilibili, YouTube, TikTok/Douyin, Xiaohongshu, podcasts, public media URLs, and local files when the bibi CLI is available."
---

# 音视频字幕与内容总结

## Core contract

本 skill 的**主功能是获取字幕**，不是调用 BibiGPT 的总结接口。

```text
音视频 URL / 本地文件
  → bibi CLI 的 --subtitle 或 BibiGPT /v1/getSubtitle
  → 本地标准化、时间轴校验、紧凑转录
  → Codex 按用户需求总结、解释、检索和排版
```

除账户查询 `/v1/me`、必要的 API 错误处理和凭证解析外，正常内容任务不调用：

- `/v1/summarize`
- `/v1/summarizeWithConfig`
- `/v1/summarizeByChapter`

“快速总结”“详细总结”“章节结构”“学习文档”都是**字幕获取之后由 Codex 完成的输出工作流**，不是 BibiGPT API 模式。

## Use this skill when

- 用户提供 Bilibili、YouTube、TikTok/Douyin、小红书、播客或其他公开音视频 URL；
- 用户提供本地音频或视频文件，并希望提取字幕或整理内容；
- 用户说“提取字幕”“转录”“总结视频”“详细梳理”“整理成学习文档”“这个视频值不值得看”；
- 用户需要基于同一份字幕做快速摘要、详细总结、结构化梳理、学习判断或内容问答；
- 用户需要批量取得多条音视频的字幕，再由 Codex 做比较或汇总。

如果用户只提供裸 URL 且没有说明用途，默认：**获取字幕 → 给出简洁的内容概览**；不要调用 BibiGPT 总结接口。

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

详细步骤见 `workflows/`：

- `transcript.md`：字幕与时间轴转录
- `quick-summary.md`：快速总结
- `detailed-summary.md`：详细总结
- `structured-summary.md`：基于字幕的结构/章节总结
- `learning-note.md`：学习文档
- `batch.md`：批量字幕获取与后处理

## 凭证可用性检查

开始任何网络内容任务前，先确认 BibiGPT API 凭证来源。脚本按以下优先级处理：

1. 显式 `--registry`；
2. 显式 `--token-env NAME`；
3. 进程环境变量 `BIBI_API_TOKEN`；
4. 当前项目 `.env` 中的 `BIBI_API_TOKEN`；
5. 进程环境变量或当前项目 `.env` 中的 `BIBIGPT_TOKEN_REGISTRY` 指向的账号文件；
6. 当前项目根目录 `accounts.json`；
7. 兼容旧项目的 `accounts-tokens.json`。

`accounts.json` 是推荐的新名称，`accounts-tokens.json` 只用于兼容迁移。显式参数优先于自动发现；不会从 skill 目录读取或写入 Token。

找到 Token 后，`subtitle` 和 `batch` 会先调用 `/v1/me` 进行余额与授权预检，再请求 `/v1/getSubtitle`。`remainingMinutes <= 0` 或 401/402/403 等错误会停止并报告；不自动换号、轮换 Token 或绕过额度。Ego Lite 仅在用户明确要求网页验证，或明确允许在合法 API/CLI 不可用时作为兜底时使用，默认不启动。

## 首次配置

Token 只能由用户本人或明确授权账户提供。优先使用项目级配置，不要把 Token 发到聊天、普通日志、Git 或 skill 文件中。

### 方式 A：进程环境变量（单 Token）

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

`.env` 只应保存单 Token 或账号文件路径；账号文件和 `.env` 应加入项目 `.gitignore`，工具写入时会尽力收紧为 `0600`。

### 方式 C：批量导入到 `accounts.json`

准备一个换行分隔文本文件，每行一个 Token（空行和 `#` 注释会跳过），或准备包含 `accounts` 数组的 JSON 文件：

```bash
python3 scripts/token_registry.py import \
  --registry ./accounts.json \
  --input ./tokens.txt \
  --acknowledge-plaintext-token-storage
```

也可以直接使用账号格式：

```json
{
  "accounts": [
    {"id": "account-01", "api_token": "<你的Token>", "remaining_minutes": null}
  ]
}
```

批量导入会自动去重、复用空槽位并把账号文件路径写入项目 `.env`；后续任务可显式传 `--registry ./accounts.json`。导入不会注册账号、验证验证码、收集 Cookie 或自动轮换 Token。

### 交互式任务

如果当前会话有 PTY 且用户没有可用配置，agent 可以在当前任务内调用隐藏输入，创建或绑定项目级账号文件，然后继续字幕任务。Token 不回显，也不写入 skill。没有 TTY 的 CI/批处理环境应先由用户在项目中完成上述配置，或显式运行：

```bash
python3 scripts/token_registry.py repair \
  --registry ./accounts.json \
  --env-file ./.env \
  --acknowledge-plaintext-token-storage
```

已有账号文件只绑定路径：

```bash
python3 scripts/token_registry.py bind \
  --registry ./accounts.json \
  --env-file ./.env
```

## Acquisition modes

按以下顺序选择字幕获取方式：

1. **已有本地字幕 JSON**：不重新请求网络，直接运行本地标准化和转录脚本；
2. **已安装 `bibi` CLI**：使用 `bibi summarize "<INPUT>" --subtitle --json`；它可以处理 URL 和本地音视频；
3. **官方 API**：使用 `scripts/acquire_subtitle.py subtitle`，只请求 `/v1/getSubtitle`；
4. **Ego Lite 兜底**：仅在没有合法 API/CLI、官方 API 不可达、响应结构不兼容，或用户明确要求网页验证时使用。

支持的输入包括：

- Bilibili、YouTube、TikTok/Douyin、小红书、播客；
- 公开可下载的 `.mp3`、`.mp4`、`.wav`、`.m4a` 等媒体 URL；
- 本地音频/视频文件（优先使用 `bibi` CLI）。

API 模式的本地文件不能直接上传；没有 CLI 时，应让用户提供公开可访问的文件 URL，不要私自上传文件。

## Synthesis policy

字幕是视频内容的事实底稿。获取字幕后，根据用户的目标和个人习惯决定总结颗粒度，不要被固定模板替代判断。

证据优先级：

1. **字幕和元数据**：支持“视频明确说了什么”；
2. **用户已确认的偏好、项目记忆和本地知识库**：决定输出风格、重点和关联背景；
3. **模型通识**：用于解释术语、补足必要前置知识；
4. **联网搜索**：只在用户要求、内容涉及当前变化、术语不确定或需要外部核验时使用；必须把外部信息标为背景，不得伪装成视频原话。

最终内容要区分：

- **字幕已验证**：字幕或元数据直接支持；
- **背景补充**：来自知识库、模型知识或联网资料；
- **当前任务判断**：Codex 根据用户目标做出的分析；
- **无法确认**：字幕缺失、含混或没有足够证据。

不要因为字幕有口语、错别字、推广或没有代码就大幅删去主题相关的解释、案例、风险、限制、因果关系和结论。

## Artifacts

默认把**主产物**放在 `media-artifacts/` 根目录，把字幕获取阶段的**副产物**放进来源 ID 文件夹。Bilibili 使用 BV 号作为来源 ID；其他来源使用稳定的短 ID。

```text
media-artifacts/
├── README.md               # 主产物索引
├── <标题>.md               # 主产物：总结、说明书或学习文档
└── <source-id>/
    ├── README.md           # 副产物导航
    ├── raw-subtitle.json   # 脱敏后的原始 API/CLI 响应
    ├── metadata.json       # 标题、作者、时长、来源、获取方式、覆盖信息
    ├── transcript.md       # 可回查的时间轴转录
    └── status.json         # 字幕获取状态和非敏感响应摘要
```

主产物命名规则：

- 默认使用视频标题或任务标题的清理版；
- 不把 `-raw-subtitle`、`-metadata`、`-transcript`、`-software-manual` 等技术后缀拼进主产物名称；
- 不把 BV 号重复拼到主产物名称；BV 号只作为副产物目录名；
- 若同名主产物已存在，追加短来源 ID，避免覆盖；
- 生成主产物后，必须更新 `media-artifacts/README.md`，指向主产物和对应副产物目录；
- 交付主产物时，在文末增加 `## 副产物导航`，至少链接到 `<source-id>/README.md`；
- 副产物固定使用 `raw-subtitle.json`、`metadata.json`、`transcript.md`、`status.json` 等短名称。

总结由当前任务按需生成，不调用或生成 BibiGPT 的“初步总结”结果文件。若用户要求保存学习文档，再把主产物直接写入 `media-artifacts/` 根目录。

## Transcript formatting

默认每 10 条字幕 cue 合并为一个时间段，但**句子不能挤成一整串**。每个 cue 默认直接换行分隔，不插入“句间分隔”之类的伪文本。例如：

```markdown
### 00:00–00:13
为什么我看网上那些教程明明就几行代码接个API agent就跑起来了
对话还挺流畅而我照着做了一个放到公司业务里第三天就崩了
延迟高结果飘还被老板骂是傻
```

如需其他格式，可以传入：

- `--sentence-separator linebreak`：默认，直接换行；
- `--sentence-separator '|'`：输出 `句子 A | 句子 B`；
- `--sentence-separator space`：使用空格；
- `--sentence-separator "<自定义字符串>"`：使用明确指定的自定义分隔符。

如需逐 cue 对照，使用 `--sentences-per-group 1`。完整原始 cue 只保存在 `raw-subtitle.json`，不能把分组转录误称为逐句原文。

## Credentials and safety

- 使用账号文件时先 `/v1/me` 预检并回写非敏感余额快照；直接环境变量或 `.env` 单 Token 也会先预检，但不会自动写入账号文件；
- Token 只能来自用户本人或明确授权账户的环境变量、`.env`、项目级 `accounts.json`/`accounts-tokens.json`、系统密钥链或显式环境变量；不在输出、日志、Markdown、Git 或截图中写入 Token、Cookie、Authorization 或完整认证 URL；
- 不自动注册账号、收集 Cookie、轮换 Token 或绕过额度、付费、频控和风控；
- API 错误按 401、402/403、404、429、5xx 和字幕缺失分别报告，不把失败记成完成；
- API 成功时不启动 Ego Lite，也不为了“验证一下”重复访问网页；
- 用户明确指定 Ego Lite/ego-browser 时，网页操作必须留在 Ego Lite，不得静默换成 Chrome、Playwright 或普通爬虫。

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
- `media-artifacts/README.md` 必须能指向主产物和对应副产物；
- 主产物必须能通过“副产物导航”链接回对应来源 ID 文件夹 README；
- 总结中的外部资料与视频原文分开标记；
- 未输出 Token、Cookie、请求头或认证参数；
- 文档链接保留原始媒体链接。

## Related skills

- `bibi`：参考 CLI/API/MCP 的环境检测和产品级命令；本 skill 只借鉴其目录与工作流组织，不照搬其总结接口链路。当前机器未发现 `bibi` 命令时，直接走官方 API 或说明需安装 CLI；
- `ego-browser`：网页登录、可见验收和 API 不可用时的字幕兜底；
- `share-transcript-distiller`：已有字幕后进一步蒸馏成知识笔记；
- `daily-note-kb-distiller`：用户要求归档到知识库时使用。

旧版 `summary` / `hybrid` 命令和“BibiGPT 初步总结”产物不再是正常链路；已有旧产物仍可作为本地输入，但新的内容任务统一遵循“先字幕、后由 Codex 总结”。
