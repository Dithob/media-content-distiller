# 项目级授权账号文件

> 本文件中的 `scripts/...` 命令默认从 skill 仓库根目录执行；安装后请将 `scripts/` 替换为实际安装目录，或先 `cd` 到 skill 目录。

账号文件只保存用户手动提供的合法 BibiGPT API Token 和非敏感余额快照；它不是账号注册器、Cookie 池或失败后的轮换器，也不能放在 skill 目录里。

## 推荐结构

```text
当前项目/
├── .env                         # 单 key 存 BIBI_API_TOKEN，多 key 存账号文件指针
└── accounts.json                # 推荐账号文件名；权限 0600，加入 .gitignore
```

旧项目的 `accounts-tokens.json` 仍兼容，但新配置默认使用 `accounts.json`。

单 key 时 `.env` 直接写：

```dotenv
BIBI_API_TOKEN=<你的Token>
```

多 key 时 `.env` 写账号文件指针：

```dotenv
BIBIGPT_TOKEN_REGISTRY=./accounts.json
```

如果账号文件放在项目子目录，写相对 `.env` 的路径，例如：

```dotenv
BIBIGPT_TOKEN_REGISTRY=./bilibili-video-ai-doc-safe-sim/accounts.json
```

## 凭证发现顺序

`media-content-distiller` CLI、`acquire_subtitle.py` 和 `token_registry.py check` 按以下兜底链查找：

1. 显式 `--registry` / `--token-env NAME`；
2. 进程环境变量 `BIBI_API_TOKEN`；
3. 项目 `.env` 的 `BIBI_API_TOKEN`；
4. 项目 `.env` 或进程环境变量的 `BIBIGPT_TOKEN_REGISTRY`；
5. 项目根 `accounts.json`；
6. 旧名 `accounts-tokens.json`；
7. 只有用户明确要求时才进入网页兜底流程，默认不启动。

显式 `--registry` 优先级最高；默认发现到 `accounts.json` 后也可用 `--registry ./accounts.json` 固定来源。

## 让用户提供 key

面向用户优先给 bash/PowerShell 指令，不要让用户手动配置 Python 环境：

- 环境变量（单 key）：`export BIBI_API_TOKEN="<你的Token>"` 或 `$env:BIBI_API_TOKEN="<你的Token>"`；
- `.env`（单 key）：`BIBI_API_TOKEN=<你的Token>`；
- 批量导入（多 key）：按换行分隔文本文件每行一个 key，或直接按账号格式填写 `accounts.json`。

本 skill 的 Node.js CLI 和 Python 兼容入口都使用上述 BibiGPT API Token。API
字幕获取只接受公开 URL；本地文件不会因为找到 API Token 就被错误上传，也不会被
自动转换或上传。需要处理本地媒体时，请先由用户提供公开可访问的媒体 URL，或仅对
已有的本地字幕 JSON 使用 `normalize`/`render`。

## 批量导入

```bash
media-content-distiller import \
  --registry ./accounts.json \
  --input ./tokens.txt \
  --acknowledge-plaintext-token-storage
```

`--input` 支持：

- 文本文件：每行一个 Token，`#` 开头为注释，自动去重；
- JSON 文件：`{"accounts": [{"id": "account-01", "api_token": "...", "remaining_minutes": null}]}`。

导入会复用空槽位、自动追加新槽位，并把 `BIBIGPT_TOKEN_REGISTRY` 写入 `.env`。如果只设置了单 Token 环境变量或 `.env`，不会自动创建账号文件。

## 交互式初始化（单 key）

脚本/交互式环境可直接使用：

```bash
media-content-distiller setup \
  --registry ./accounts.json \
  --env-file ./.env \
  --slots 1 \
  --acknowledge-plaintext-token-storage
```

`--slots` 可以按需要改为 20。Token 写入第一个空槽位，初始 `remaining_minutes` 为 `null`；第一次 API 请求会通过 `/v1/me` 更新余额。

## 自动修复与绑定

`.env` 指向不存在的文件时：

```bash
media-content-distiller repair \
  --registry ./accounts.json \
  --env-file ./.env \
  --acknowledge-plaintext-token-storage
```

已有账号文件时只绑定当前项目：

```bash
media-content-distiller bind \
  --registry ./accounts.json \
  --env-file ./.env
```

## 可用性检查

```bash
media-content-distiller check
```

只报告 key 来源、账号槽位、是否有 Token 和缓存余额，不输出 Token，也不发起 `/v1/me` 网络请求；字幕任务自身会在内容请求前做 `/v1/me` 预检。

## 其他槽位操作

新增或替换单个槽位：

```bash
media-content-distiller add \
  --registry ./accounts.json \
  --account-id account-01 \
  --acknowledge-plaintext-token-storage
```

Token 通过隐藏提示输入；测试或非交互环境可加 `--token-stdin`。`list` 只输出槽位是否有 Token 和余额，不输出 Token：

```bash
media-content-distiller list --registry ./accounts.json
```

## 选择规则

- 只按 `accounts` 数组顺序选择第一个有 Token 且 `remaining_minutes > 0` 的槽位；
- `remaining_minutes: null` 表示未知余额，视为可预检候选；
- 不做轮询，不因 401、402/403 或 429 自动切换账号；
- 每次使用账号文件时先 `/v1/me`，成功后回写非敏感余额；
- `disable` 会清空槽位并把余额设为 0。

Node.js CLI 和 Python 兼容入口均使用 API registry。公开 URL 任务先调用
`/v1/me`，再调用 `/v1/getSubtitle`；本地媒体路径在凭证解析和网络请求之前安全失败。

上述 Node.js 命令是新用户的首选初始化和操作方式；Python 版本仅用于兼容已有脚本：

```bash
python3 scripts/token_registry.py setup ...
python3 scripts/token_registry.py repair ...
python3 scripts/token_registry.py bind ...
python3 scripts/token_registry.py import ...
```

## 安全边界

- 账号文件和 `.env` 均尽力强制 `0600`（POSIX）；Windows 上 chmod 仅为尽力而为，由用户/项目 ACL 管理；
- `.env` 只保存单 key 或账号文件路径指针，Token 不写入 skill、日志、Markdown、Git、截图、manifest 或请求 URL；
- `.gitignore` 应包含 `.env`、`.env.*`、`**/accounts.json` 和 `**/accounts-tokens.json`；
- 如果用户不愿意在本地 JSON 中保存明文 Token，应由用户另行配置系统密钥链，不要自动收集、注册、轮换或绕过服务方额度。
