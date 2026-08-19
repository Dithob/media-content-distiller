# Token registry

账号文件只保存用户手动提供的授权 Token 和非敏感探测快照；它不是账号注册器、Cookie 池、自动轮换器或额度绕过器，也不能放在 skill 仓库里。

## 推荐结构

```text
当前项目/
├── .env
└── accounts.json
```

`.env` 可以保存单 Token：

```dotenv
BIBI_API_TOKEN=<user-authorized-token>
```

也可以只保存 registry 指针：

```dotenv
BIBIGPT_TOKEN_REGISTRY=./accounts.json
```

查找顺序：显式 `--registry` → `--token-env` → 进程 `BIBI_API_TOKEN` → 项目 `.env` 单 Token → registry 指针 → 项目 `accounts.json` → 旧名 `accounts-tokens.json`。

## 初始化与全量探测

```bash
media-content-distiller setup \
  --registry ./accounts.json \
  --env-file ./.env \
  --acknowledge-plaintext-token-storage
```

`setup` 写入 Token 后会默认检查 registry 中**所有 Token**，每个 Token 使用一次 `GET /v1/me`。探测结果只包含账号 ID、状态、套餐、剩余分钟数、HTTP 状态和检查时间：

- `usable`
- `invalid`
- `forbidden`
- `quota_exhausted`
- `rate_limited`
- `unavailable`

批量导入同样全量探测：

```bash
media-content-distiller import \
  --registry ./accounts.json \
  --env-file ./.env \
  --input ./tokens.txt \
  --acknowledge-plaintext-token-storage
```

后续重新探测：

```bash
media-content-distiller probe --registry ./accounts.json
media-content-distiller list --registry ./accounts.json
```

`check` 只检查本地配置，不发网络请求；`probe` 才验证真实授权和额度。只有明确想跳过网络探测时才使用 `--skip-probe`。

## 单 Token 与 registry 的选择

一次性任务只有一个 Token 时，直接设置 `BIBI_API_TOKEN` 并用 `curl` 即可，不必创建
registry。需要保存多个 Token、重复执行或查看额度快照时，再使用 CLI registry。

## 选择与运行

- 使用 registry 时按数组顺序选择第一个状态不是明确失败、且余额大于零的 Token；
- 未知余额会在实际字幕任务前再次 `/v1/me` 预检；
- 401、402/403、429 或 quota 错误不会自动换号或轮换；
- 公开 URL 任务固定 `/v1/me` → `/v1/getSubtitle`；
- 本地媒体路径在 Token 解析和网络请求前失败，不自动上传；
- Python registry 命令只是 Node CLI 转发器。

## 安全

- registry 和 `.env` 尽力设置为 `0600`，并加入 `.gitignore`；
- Token 不写入日志、README、status、metadata、transcript、Git 或请求 URL；
- 不自动注册账号、收集 Cookie、处理验证码、轮换 Token 或绕过额度；
- 不要将真实 Token 发到聊天或作为普通命令参数。
