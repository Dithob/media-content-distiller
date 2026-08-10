# media-content-distiller

一个可独立安装的音视频字幕与内容蒸馏 skill：先从 Bilibili、YouTube、TikTok/Douyin、小红书、播客或公开媒体 URL 获取可验证字幕，再由 Codex 生成转录、快速总结、详细总结、结构梳理、学习文档、问答或多视频比较。

> 核心边界：BibiGPT 主要作为字幕提供方；正常内容链路只调用 `getSubtitle`，不把 BibiGPT 的总结接口当作默认输出引擎。

[![Skill](https://img.shields.io/badge/agent--skill-media--content--distiller-2563eb)](SKILL.md)
[![License](https://img.shields.io/badge/license-MIT-22c55e)](LICENSE)

## 能力

- 字幕优先：`bibi summarize <input> --subtitle --json`，或官方 `/v1/getSubtitle` API 路径
- 支持 URL 和本地媒体文件（本地文件优先需要 `bibi` CLI）
- 标准化 `subtitlesArray`、`subtitles[]`、Bilibili `body[]`，校验时间轴并渲染时间戳转录
- 快速总结、详细总结、结构/章节总结、学习文档、内容问答和批量比较由 Codex 基于同一份字幕完成
- 项目级 Token registry：显式配置优先、隐藏输入、0600 权限、余额预检、停止而不自动轮换
- 脱敏原始响应、元数据、状态和转录产物；主产物与来源副产物分离
- Ego Lite 仅作为用户明确要求的可见网页验证或 API/CLI 不可用时的兜底，不静默改用其他浏览器

## 安装

将本仓库推送到 GitHub 后，可以用 Skills CLI 安装：

```bash
npx skills add <owner>/<repo> --skill media-content-distiller -g -y
```

如果仓库根目录就是这个 skill，也可以省略 `--skill`：

```bash
npx skills add <owner>/<repo> -g -y
```

安装到指定 agent 的示例：

```bash
npx skills add <owner>/<repo> --skill media-content-distiller -a codex -a claude-code -y
```

本地验证发现与安装：

```bash
npx skills add . --list
npx skills add . --skill media-content-distiller --copy -y
```

发布到 GitHub 后，用实际的 `<owner>/<repo>` 替换占位符；本仓库不自动创建远程仓库或推送代码。

## 快速使用

### 1. 优先使用 `bibi` CLI

```bash
bibi summarize "<URL-or-local-file>" --subtitle --json
```

### 2. 没有 CLI 时走官方 API

```bash
python3 scripts/acquire_subtitle.py subtitle \
  --input "https://example.com/video" \
  --output-dir ./media-artifacts
```

API 模式只接受 URL；不能把本地文件直接上传给 API。API 请求前会调用 `/v1/me` 预检，字幕请求使用 `/v1/getSubtitle`。401、402/403、429、额度耗尽、字幕为空或时间轴异常时停止并报告，不把失败写成完成。

### 3. 已有本地字幕 JSON 时离线渲染

```bash
python3 scripts/normalize_subtitle.py --input ./raw-subtitle.json
python3 scripts/render_transcript.py \
  --subtitle ./raw-subtitle.json \
  --metadata ./metadata.json \
  --out-dir ./media-artifacts/source-id \
  --artifact-id source-id
```

默认每 10 条 cue 合并一个时间段，组内直接换行；逐 cue 输出使用 `--sentences-per-group 1`。需要其他分隔符时使用 `--sentence-separator '|'`、`space` 或自定义字符串。

## 凭证配置

不要把 Token 粘贴到聊天、普通命令参数、Git、skill 文件或产物中。可选方式：

```bash
# 当前进程使用单 Token
export BIBI_API_TOKEN="<user-authorized-token>"
```

```dotenv
# 项目 .env：单 Token
BIBI_API_TOKEN=<user-authorized-token>

# 或多 Token registry 指针（二选一，不要同时配置）
# BIBIGPT_TOKEN_REGISTRY=./accounts.json
```

首次交互式任务可以在当前 PTY 中通过隐藏输入初始化 registry；无 TTY 的环境请先由用户配置，或显式运行：

```bash
python3 scripts/token_registry.py repair \
  --registry ./accounts.json \
  --env-file ./.env \
  --acknowledge-plaintext-token-storage
```

批量导入已授权 Token：

```bash
python3 scripts/token_registry.py import \
  --registry ./accounts.json \
  --input ./tokens.txt \
  --acknowledge-plaintext-token-storage
```

registry 与 `.env` 会尽力设置为 `0600`，并被本仓库 `.gitignore` 忽略。工具不会注册账号、收集 Cookie、处理验证码、自动换号、轮换 Token 或绕过额度。

## 产物布局

```text
media-artifacts/
├── README.md
├── <标题>.md                 # Codex 生成的主产物
└── <source-id>/
    ├── README.md
    ├── raw-subtitle.json     # 脱敏后的字幕响应
    ├── metadata.json
    ├── transcript.md
    └── status.json
```

主产物放在 `media-artifacts/` 根目录，字幕获取副产物放在来源 ID 文件夹。主产物应包含 `## 副产物导航`，根索引和来源目录 README 互相可回查。不要把转录文件误称为官方逐句原文：它是按配置分组的可读转录，完整 cue 保存在脱敏后的原始 JSON 中。

## 验证

不需要网络或真实 API Token：

```bash
python3 scripts/verify_skill.py
python3 -m unittest discover -s tests -v
```

在 macOS 上如果 Python 缓存目录受限：

```bash
PYTHONPYCACHEPREFIX=/tmp/media-content-distiller-pycache \
  python3 scripts/verify_skill.py
```

验证覆盖：frontmatter、`agents/openai.yaml`、公开文件疑似密钥、Python 编译、CLI 帮助、凭证缺失时不发起网络请求、本地字幕结构与时间轴、分组转录、敏感字段脱敏、Token registry 权限与不泄露输出。

这些离线检查和 fixture 只证明本地代码路径与安全边界被验证，不代表真实 BibiGPT 账号、付费额度、网络连通性或服务端当前响应一定可用。

## 目录

```text
media-content-distiller/
├── SKILL.md
├── agents/openai.yaml
├── scripts/                 # 字幕获取、标准化、转录和 Token registry
├── references/              # API、凭证、产物与证据策略
├── workflows/               # 转录、总结、学习文档、批处理工作流
├── tests/                   # 离线单元测试
├── scripts/verify_skill.py  # 离线仓库验证
├── .env.example
├── LICENSE
├── CHANGELOG.md
└── README.md
```

## 发布检查

1. 确认仓库只包含 skill 代码、文档、测试和示例配置，不包含 `.env`、`accounts.json`、真实 Token、Cookie、缓存或媒体产物。
2. 运行 `python3 scripts/verify_skill.py` 和 `python3 -m unittest discover -s tests -v`。
3. 初始化 Git 并提交后推送到公开 GitHub 仓库。
4. 在干净目录执行 `npx skills add <owner>/<repo> --list`，确认能发现 `media-content-distiller`。
5. 执行 `npx skills add <owner>/<repo> --skill media-content-distiller --copy -y`，再运行离线验证。
6. 仅在用户有合法账号、明确授权和可接受额度时做真实 API 验证，并单独记录网络/额度/服务端失败。

## 相关 skill

- `bibi`：可作为字幕 CLI/API 的产品级参考；本仓库不复制其总结接口链路。
- `ego-browser`：用户明确要求可见网页操作或 API/CLI 兜底时使用。
- `share-transcript-distiller`：已有字幕后进一步蒸馏为知识笔记。
- `daily-note-kb-distiller`：需要归档到本地知识库时使用。

## 许可证

MIT，见 [LICENSE](LICENSE)。
