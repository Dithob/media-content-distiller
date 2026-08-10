#!/usr/bin/env python3
"""Acquire subtitles from BibiGPT and render a local transcript.

This client deliberately performs one content operation: /v1/getSubtitle.
Quick summaries, detailed summaries, chapter structure, learning notes, and
Q&A are produced by Codex from the saved subtitle artifact, not by calling a
second BibiGPT summary endpoint.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

from render_transcript import normalize_subtitles
from token_registry import (
    DEFAULT_ACCOUNTS_FILE,
    ENV_TOKEN_KEY,
    ENV_REGISTRY_KEY,
    LEGACY_ACCOUNTS_FILE,
    command_setup,
    default_registry_path,
    discover_dotenv,
    load_registry,
    read_dotenv_value,
    resolve_path_reference,
    write_env_pointer,
)

SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_BASE_URL = "https://api.bibigpt.co/api"


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8-sig") as handle:
        return json.load(handle)


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def redact_string(value: str) -> str:
    value = re.sub(r"(?i)(Bearer\s+)[A-Za-z0-9._~+/=-]+", r"\1[REDACTED]", value)
    return re.sub(
        r"(?i)([?&](?:api[_-]?key|api[_-]?token|access[_-]?token|"
        r"authorization|cookie|secret|token)=)[^&#\s]+",
        r"\1[REDACTED]",
        value,
    )


def safe_json(value: Any) -> Any:
    """Redact credential-shaped fields before writing an artifact."""
    if isinstance(value, list):
        return [safe_json(item) for item in value]
    if isinstance(value, dict):
        result: dict[str, Any] = {}
        for key, item in value.items():
            if re.search(
                r"token|cookie|secret|password|authorization|api[_-]?key", key, re.I
            ):
                result[key] = "[REDACTED]"
            else:
                result[key] = safe_json(item)
        return result
    if isinstance(value, str):
        return redact_string(value)
    return value


def slugify(input_value: str, title: str | None = None) -> str:
    source = title or input_value.rstrip("/").rsplit("/", 1)[-1] or "media-content"
    source = re.sub(r"[^\w\u4e00-\u9fff-]+", "-", source, flags=re.UNICODE)
    slug = re.sub(r"-{2,}", "-", source).strip("-_") or "media-content"
    return slug


def source_id(input_value: str) -> str:
    """Return a short, stable folder name for source-side artifacts."""
    bvid_match = re.search(r"(BV[0-9A-Za-z]+)", input_value)
    if bvid_match:
        return bvid_match.group(1)
    parsed = urllib.parse.urlparse(input_value)
    tail = parsed.path.rstrip("/").rsplit("/", 1)[-1]
    candidate = re.sub(r"[^\w-]+", "-", tail, flags=re.UNICODE).strip("-_")
    if candidate and len(candidate) <= 48:
        return candidate
    digest = hashlib.sha1(input_value.encode("utf-8")).hexdigest()[:12]
    return f"source-{digest}"


def output_title_slug(input_value: str, title: str | None = None) -> str:
    """Return the clean main-document basename without source/type suffixes."""
    return slugify(input_value, title) or source_id(input_value)


def choose_main_product_path(output_dir: Path, title_slug: str, artifact_id: str) -> Path:
    """Avoid overwriting a different source that happens to share a title."""
    candidate = output_dir / f"{title_slug}.md"
    if not candidate.exists():
        return candidate
    try:
        text = candidate.read_text(encoding="utf-8")
    except OSError:
        text = ""
    if artifact_id in text:
        return candidate
    return output_dir / f"{title_slug}-{artifact_id}.md"


def looks_like_url(value: str) -> bool:
    return bool(re.match(r"^https?://", value.strip(), re.I))


class ApiError(RuntimeError):
    def __init__(self, status: int, detail: Any, retry_after: str | None = None):
        self.status = status
        self.detail = safe_json(detail)
        self.retry_after = retry_after
        super().__init__(f"BibiGPT API 请求失败：HTTP {status}")


def request_json(
    base_url: str,
    path: str,
    token: str,
    *,
    method: str = "GET",
    query: dict[str, Any] | None = None,
    timeout: int = 90,
    retries: int = 2,
) -> tuple[int, Any]:
    query = query or {}
    encoded_query = urllib.parse.urlencode(
        {
            key: str(value).lower() if isinstance(value, bool) else str(value)
            for key, value in query.items()
            if value is not None
        }
    )
    url = base_url.rstrip("/") + "/" + path.lstrip("/")
    if encoded_query:
        url += "?" + encoded_query
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/json",
            "Authorization": f"Bearer {token}",
            "x-client-type": "bibi-cli",
            "User-Agent": "media-content-distiller/2.0",
        },
        method=method,
    )
    attempt = 0
    while True:
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                raw = response.read().decode("utf-8", errors="replace")
                try:
                    return response.status, json.loads(raw)
                except json.JSONDecodeError:
                    return response.status, {"raw": raw[:4000]}
        except urllib.error.HTTPError as error:
            raw = error.read().decode("utf-8", errors="replace")
            try:
                detail = json.loads(raw)
            except json.JSONDecodeError:
                detail = {"raw": raw[:2000]}
            if error.code >= 500 and attempt < retries:
                time.sleep(min(2**attempt, 8))
                attempt += 1
                continue
            raise ApiError(error.code, detail, error.headers.get("Retry-After")) from error
        except (urllib.error.URLError, TimeoutError) as error:
            if attempt < retries:
                time.sleep(min(2**attempt, 8))
                attempt += 1
                continue
            raise ApiError(0, {"message": str(error)}) from error


def response_detail(response: Any) -> dict[str, Any]:
    if not isinstance(response, dict):
        return {}
    detail = response.get("detail")
    return detail if isinstance(detail, dict) else {}


def response_metadata(response: Any, *, input_value: str, transport: str) -> dict[str, Any]:
    detail = response_detail(response)
    source_url = detail.get("url") or (response.get("sourceUrl") if isinstance(response, dict) else None)
    if not source_url:
        source_url = input_value
    subtitle_source = detail.get("subtitleSource") or detail.get("subtitleUrl")
    if not subtitle_source:
        subtitle_source = "BibiGPT 官方 /v1/getSubtitle"
    return {
        "success": response.get("success") if isinstance(response, dict) else None,
        "id": response.get("id") if isinstance(response, dict) else None,
        "service": response.get("service") if isinstance(response, dict) else None,
        "platform": response.get("service") if isinstance(response, dict) else None,
        "url": redact_string(str(source_url)) if source_url else input_value,
        "sourceUrl": redact_string(str(response.get("sourceUrl")))
        if isinstance(response, dict) and response.get("sourceUrl")
        else input_value,
        "title": detail.get("title"),
        "author": detail.get("author"),
        "duration": detail.get("duration"),
        "durationSec": detail.get("duration"),
        "subtitleSource": redact_string(str(subtitle_source)),
        "apiMode": "subtitle-only",
        "operation": "getSubtitle",
        "transport": transport,
        "costDuration": response.get("costDuration") if isinstance(response, dict) else None,
        "remainingTime": response.get("remainingTime") if isinstance(response, dict) else None,
        "remainingMinutes": remaining_minutes(response),
        "fromCache": response.get("fromCache") if isinstance(response, dict) else None,
    }


def remaining_minutes(response: Any) -> float | None:
    if not isinstance(response, dict):
        return None
    for key in ("remainingMinutes", "remaining_minutes"):
        value = response.get(key)
        if value is not None:
            try:
                return float(value)
            except (TypeError, ValueError):
                return None
    for key in ("remainingTime", "remaining_time"):
        value = response.get(key)
        if value is not None:
            try:
                return float(value) / 60.0
            except (TypeError, ValueError):
                return None
    return None


def require_private_registry(path: Path) -> None:
    if not path.exists():
        return
    if os.name == "nt":
        # Windows has no POSIX mode bits; chmod is best-effort and the ACL is
        # managed by the user/project, so skip the mode check there.
        return
    mode = path.stat().st_mode & 0o777
    if mode & 0o077:
        raise SystemExit(f"registry 权限过宽（{oct(mode)}）：请先 chmod 600 {path}")


def load_registry_accounts(path: Path) -> list[dict[str, Any]]:
    require_private_registry(path)
    try:
        registry = load_json(path)
    except FileNotFoundError as error:
        raise SystemExit(f"找不到 registry：{path}") from error
    except json.JSONDecodeError as error:
        raise SystemExit(f"registry 不是合法 JSON：{path}") from error
    accounts = registry.get("accounts") if isinstance(registry, dict) else None
    if not isinstance(accounts, list):
        raise SystemExit("registry 格式无效：需要包含 accounts 数组")
    return [account for account in accounts if isinstance(account, dict)]


def update_registry_balance(
    registry_path: Path | None,
    account_id: str | None,
    response: Any,
    *,
    fallback_remaining_minutes: float | None = None,
) -> None:
    if not registry_path or not account_id:
        return
    require_private_registry(registry_path)
    registry = load_json(registry_path)
    accounts = registry.get("accounts", [])
    for account in accounts:
        if isinstance(account, dict) and account.get("id") == account_id:
            observed = remaining_minutes(response)
            if observed is not None:
                account["remaining_minutes"] = observed
            elif fallback_remaining_minutes is not None:
                account["remaining_minutes"] = fallback_remaining_minutes
            break
    else:
        raise SystemExit(f"找不到账号槽位：{account_id}")
    write_json(registry_path, registry)
    os.chmod(registry_path, 0o600)


def select_registry_account(args: argparse.Namespace) -> tuple[str, str]:
    candidates = load_registry_accounts(args.registry)
    if args.account_id:
        for account in candidates:
            if account.get("id") != args.account_id:
                continue
            token = str(account.get("api_token") or "").strip()
            if not token:
                raise SystemExit(f"账号槽位没有明文 Token：{args.account_id}")
            return token, str(account["id"])
        raise SystemExit(f"找不到账号槽位：{args.account_id}")

    for account in candidates:
        token = str(account.get("api_token") or "").strip()
        if not token:
            continue
        cached = account.get("remaining_minutes")
        if cached is not None:
            try:
                if float(cached) <= 0:
                    continue
                if args.minimum_minutes is not None and float(cached) < args.minimum_minutes:
                    continue
            except (TypeError, ValueError):
                pass
        return token, str(account.get("id"))
    raise SystemExit("registry 中没有可用 Token；请检查 api_token 和 remaining_minutes")


def resolve_env_file(args: argparse.Namespace) -> Path | None:
    explicit = getattr(args, "env_file", None)
    if explicit:
        return resolve_path_reference(explicit)
    return discover_dotenv()


def discover_registry(args: argparse.Namespace) -> tuple[Path | None, Path | None]:
    """Resolve the project registry without looking inside the skill directory."""
    env_file = resolve_env_file(args)
    if getattr(args, "registry", None):
        return resolve_path_reference(args.registry), env_file

    process_value = os.environ.get(ENV_REGISTRY_KEY, "").strip()
    if process_value:
        return resolve_path_reference(process_value), env_file

    dotenv_value = read_dotenv_value(env_file, ENV_REGISTRY_KEY) if env_file else None
    if dotenv_value:
        return resolve_path_reference(dotenv_value, base_dir=env_file.parent), env_file

    base = env_file.parent if env_file else Path.cwd()
    for name in (DEFAULT_ACCOUNTS_FILE, LEGACY_ACCOUNTS_FILE):
        candidate = (base / name).resolve(strict=False)
        if candidate.exists():
            return candidate, env_file
    return None, env_file


def is_interactive_session() -> bool:
    return bool(sys.stdin.isatty() and sys.stdout.isatty())


def prompt_yes_no(question: str, *, default: bool = True) -> bool:
    suffix = "[Y/n]" if default else "[y/N]"
    answer = input(f"{question} {suffix} ").strip().lower()
    if not answer:
        return default
    return answer in {"y", "yes", "是", "确认", "确定"}


def project_registry_candidates(base_dir: Path) -> list[Path]:
    """Find only conventional project-local registry locations, never the skill directory."""
    candidates = [base_dir / DEFAULT_ACCOUNTS_FILE, base_dir / LEGACY_ACCOUNTS_FILE]
    candidates.extend(base_dir.glob(f"*/{DEFAULT_ACCOUNTS_FILE}"))
    candidates.extend(base_dir.glob(f"*/{LEGACY_ACCOUNTS_FILE}"))
    result: list[Path] = []
    seen: set[Path] = set()
    for candidate in candidates:
        if not candidate.is_file():
            continue
        resolved = candidate.resolve(strict=False)
        if resolved in seen:
            continue
        seen.add(resolved)
        result.append(resolved)
    return result


def run_interactive_setup(registry_path: Path, env_file: Path) -> Path:
    """Run hidden Token input in-process so the user does not run a setup command."""
    setup_registry = registry_path
    setup_env_file = env_file

    class SetupArgs:
        registry = setup_registry
        env_file = setup_env_file
        slots = 1
        account_id = None
        token_stdin = False
        label = None
        replace = False
        acknowledge_plaintext_token_storage = True

    command_setup(SetupArgs(), emit=False)
    return registry_path


def interactive_initialize_or_repair(
    args: argparse.Namespace,
    *,
    env_file: Path | None,
    suggested_registry: Path,
    reason: str,
    allow_candidate_scan: bool = True,
) -> Path:
    """Guide first use or a broken pointer without requiring a shell command."""
    if not is_interactive_session():
        raise SystemExit(reason)

    project_env = (env_file or (Path.cwd() / ".env")).resolve(strict=False)
    project_dir = project_env.parent
    print("\nmedia-content-distiller 需要一个项目级 BibiGPT API Token 才能获取字幕。")
    print("配置方式：环境变量 BIBI_API_TOKEN、项目 .env，或批量导入到 accounts.json。")
    print("Token 不会写入 skill；accounts.json 以 0600 权限保存在当前项目。")
    print("Token 会以明文保存在该本地文件中，但不会写入 .env、日志或产物。")
    pointer = read_dotenv_value(env_file, ENV_REGISTRY_KEY) if env_file else None
    configured_pointer = pointer or os.environ.get(ENV_REGISTRY_KEY, "").strip()
    if configured_pointer and not suggested_registry.exists():
        print(f"当前 BIBIGPT_TOKEN_REGISTRY 配置的路径不可用：{suggested_registry}")
        print("可以修复为当前项目默认路径，或绑定项目中已有的 registry。")

    if suggested_registry.exists():
        try:
            current = load_registry(suggested_registry)
        except SystemExit as error:
            raise SystemExit(f"当前 registry 无法读取：{error}") from error
        has_any_token = any(
            isinstance(account, dict) and str(account.get("api_token") or "").strip()
            for account in current.get("accounts", [])
        )
        if has_any_token:
            has_empty_slot = any(
                isinstance(account, dict) and not str(account.get("api_token") or "").strip()
                for account in current.get("accounts", [])
            )
            if has_empty_slot:
                print(f"registry 已存在，但当前缓存中没有可用 Token/额度：{suggested_registry}")
                print("为避免自动轮换或覆盖已有 Token，将把新 Token 写入第一个空槽位。")
                if not prompt_yes_no("是否现在输入新的 Token 并继续当前任务？", default=True):
                    raise SystemExit("已取消 Token 配置；未发起网络请求。")
                return run_interactive_setup(suggested_registry, project_env)
            raise SystemExit(
                f"registry 已存在但当前没有可用 Token/额度，且没有空槽位：{suggested_registry}。"
                "为避免自动轮换或覆盖已有 Token，未发起网络请求。"
            )
        print(f"发现空的项目 registry：{suggested_registry}")
        if not prompt_yes_no("是否现在输入 Token 并继续当前任务？", default=True):
            raise SystemExit("已取消 Token 配置；未发起网络请求。")
        return run_interactive_setup(suggested_registry, project_env)

    if not allow_candidate_scan:
        if not prompt_yes_no(f"是否在 {suggested_registry} 创建 registry 并导入 Token？", default=True):
            raise SystemExit("已取消 Token 配置；未发起网络请求。")
        return run_interactive_setup(suggested_registry, project_env)

    candidates = project_registry_candidates(project_dir)
    if len(candidates) == 1:
        candidate = candidates[0]
        print(f"发现项目中的 registry：{candidate}")
        if prompt_yes_no("是否绑定它并继续当前任务？", default=True):
            write_env_pointer(project_env, candidate)
            return candidate
    elif len(candidates) > 1:
        print("发现多个项目 registry，无法安全猜测使用哪一个：")
        for candidate in candidates:
            print(f"  - {candidate}")
        raise SystemExit(
            "请在当前任务中明确指定 registry；未发起网络请求。"
        )

    print("当前项目没有可用 registry。")
    if not prompt_yes_no("是否现在输入 Token 并继续当前任务？", default=True):
        raise SystemExit("已取消 Token 配置；未发起网络请求。")
    return run_interactive_setup(default_registry_path(project_env), project_env)


def resolve_token(args: argparse.Namespace) -> tuple[str, str | None, Path | None]:
    explicit_registry = getattr(args, "registry", None)
    explicit_token_env = getattr(args, "token_env", None)
    env_file = resolve_env_file(args)

    # 1. Explicit accounts file: highest priority, especially after batch import.
    if explicit_registry:
        registry_path = resolve_path_reference(explicit_registry)
        if not registry_path.exists():
            raise SystemExit(f"找不到账号文件：{registry_path}；未发起网络请求。")
        args.registry = registry_path
        token, account_id = select_registry_account(args)
        return token, account_id, registry_path

    # 2. Explicit alternative environment variable name.
    if explicit_token_env:
        token = os.environ.get(explicit_token_env, "").strip()
        if token:
            return token, None, None
        raise SystemExit(f"环境变量 {explicit_token_env} 未设置或为空")

    # 3. Default environment variable.
    token = os.environ.get(ENV_TOKEN_KEY, "").strip()
    if token:
        return token, None, None

    # 4. Single key in project .env.
    if env_file:
        token = (read_dotenv_value(env_file, ENV_TOKEN_KEY) or "").strip()
        if token:
            return token, None, None

    # 5. Accounts file: pointer, accounts.json, then legacy name.
    registry_path, env_file = discover_registry(args)
    if registry_path and registry_path.exists():
        args.registry = registry_path
        try:
            token, account_id = select_registry_account(args)
        except SystemExit as error:
            if is_interactive_session() and "没有可用 Token" in str(error):
                repaired = interactive_initialize_or_repair(
                    args,
                    env_file=env_file,
                    suggested_registry=registry_path,
                    reason=str(error),
                )
                args.registry = repaired
                token, account_id = select_registry_account(args)
            else:
                raise
        return token, account_id, args.registry

    # 6. Nothing found: non-interactive failure, or interactive guidance.
    reason = (
        "未找到可用的 BibiGPT API Token（查找顺序：BIBI_API_TOKEN 环境变量 "
        "> .env > accounts.json）。未发起网络请求。请按 SKILL.md 的“首次配置”"
        "提供 key，或显式指定 --registry/--token-env。"
    )
    repaired = interactive_initialize_or_repair(
        args,
        env_file=env_file,
        suggested_registry=default_registry_path(env_file),
        reason=reason,
    )
    args.registry = repaired
    token, account_id = select_registry_account(args)
    return token, account_id, repaired


def preflight_account(
    args: argparse.Namespace,
    token: str,
    account_id: str | None,
    registry_path: Path | None,
) -> tuple[dict[str, Any], float | None]:
    status, response = request_json(
        args.base_url,
        "/v1/me",
        token,
        timeout=args.timeout,
        retries=args.retries,
    )
    if status != 200:
        raise ApiError(status, response)
    balance = remaining_minutes(response)
    update_registry_balance(registry_path, account_id, response)
    if balance is not None and balance <= 0:
        raise ApiError(402, {"message": "API remainingMinutes <= 0"})
    return response, balance


def get_subtitle(args: argparse.Namespace, token: str) -> tuple[int, Any]:
    if not looks_like_url(args.input):
        raise SystemExit(
            "API 字幕路径只接受 URL；本地文件请安装 bibi CLI，或先提供公开可访问的媒体 URL"
        )
    return request_json(
        args.base_url,
        "/v1/getSubtitle",
        token,
        query={
            "url": args.input,
            "audioLanguage": args.audio_language,
            "enabledSpeaker": args.enabled_speaker if args.enabled_speaker else None,
            "transcribeProvider": args.transcribe_provider,
            "whisperPrompt": args.whisper_prompt,
        },
        timeout=args.timeout,
        retries=args.retries,
    )


def write_response_artifacts(
    output_dir: Path,
    input_value: str,
    response: Any,
    *,
    transport: str = "api",
) -> dict[str, Path | str]:
    output_dir.mkdir(parents=True, exist_ok=True)
    metadata = response_metadata(response, input_value=input_value, transport=transport)
    artifact_id = source_id(input_value)
    artifact_dir = output_dir / artifact_id
    artifact_dir.mkdir(parents=True, exist_ok=True)
    title_slug = output_title_slug(input_value, metadata.get("title"))
    main_product_path = choose_main_product_path(output_dir, title_slug, artifact_id)
    metadata["artifactId"] = artifact_id
    metadata["artifactDir"] = str(artifact_dir)
    metadata["mainProduct"] = main_product_path.name
    metadata["artifactLayout"] = "root-main-product/source-id-sidecars"
    subtitle_path = artifact_dir / "raw-subtitle.json"
    metadata_path = artifact_dir / "metadata.json"
    write_json(subtitle_path, safe_json(response))
    write_json(metadata_path, safe_json(metadata))
    return {
        "artifactId": artifact_id,
        "artifactDir": artifact_dir,
        "titleSlug": title_slug,
        "mainProductPath": main_product_path,
        "mainProductRelativePath": main_product_path.name,
        "subtitlePath": subtitle_path,
        "metadataPath": metadata_path,
    }


def write_artifact_readmes(
    output_dir: Path,
    artifact: dict[str, Path | str],
    *,
    input_value: str,
    metadata: dict[str, Any],
) -> dict[str, Path]:
    """Write compact navigation READMEs, keeping the main document at root."""
    artifact_id = str(artifact["artifactId"])
    artifact_dir = Path(artifact["artifactDir"])
    main_product = Path(artifact["mainProductPath"])
    title = str(metadata.get("title") or artifact["titleSlug"])
    source_url = str(metadata.get("url") or metadata.get("sourceUrl") or input_value)
    folder_readme = artifact_dir / "README.md"
    folder_readme.write_text(
        "\n".join(
            [
                f"# {artifact_id} 字幕副产物",
                "",
                f"- 来源：[{title}]({source_url})",
                f"- 主产物：[`{main_product.name}`](../{main_product.name})",
                "",
                "## 副产物",
                "",
                "- [`raw-subtitle.json`](raw-subtitle.json)：脱敏后的字幕接口原始响应。",
                "- [`metadata.json`](metadata.json)：标题、作者、时长、来源和获取方式。",
                "- [`transcript.md`](transcript.md)：可回查的时间轴转录。",
                "- [`status.json`](status.json)：字幕获取状态和非敏感响应摘要。",
                "",
                "> 主产物放在 `media-artifacts/` 根目录；本目录只保留复核和追溯所需的副产物。",
                "",
            ]
        ),
        encoding="utf-8",
    )

    root_readme = output_dir / "README.md"
    existing = root_readme.read_text(encoding="utf-8") if root_readme.exists() else ""
    marker = "<!-- media-content-distiller:index -->"
    end_marker = "<!-- /media-content-distiller:index -->"
    entry = (
        f"- [`{main_product.name}`]({main_product.name})：{title}；"
        f"[字幕副产物目录]({artifact_id}/README.md)。"
    )
    index_lines = []
    if marker in existing and end_marker in existing:
        current_block = existing.split(marker, 1)[1].split(end_marker, 1)[0]
        for line in current_block.splitlines():
            if line.startswith("- [`") and f"]({artifact_id}/README.md)" not in line:
                index_lines.append(line)
    index_lines.append(entry)
    block = "\n".join(
        [
            marker,
            "## media-content-distiller 产物索引",
            "",
            "主产物直接放在本目录根部；原始字幕、元数据、转录和状态放在对应来源 ID 文件夹。",
            "",
            *sorted(set(index_lines), key=str.casefold),
            "",
            end_marker,
        ]
    )
    if marker in existing and end_marker in existing:
        before = existing.split(marker, 1)[0].rstrip()
        after = existing.split(end_marker, 1)[1].lstrip()
        updated = f"{before}\n\n{block}\n\n{after}".strip() + "\n"
    else:
        updated = (existing.rstrip() + "\n\n" if existing.strip() else "") + block + "\n"
    root_readme.write_text(updated, encoding="utf-8")
    return {"folderReadme": folder_readme, "rootReadme": root_readme}


def render_transcript(
    output_dir: Path,
    artifact_id: str,
    subtitle_path: Path,
    metadata_path: Path,
    *,
    sentences_per_group: int,
    sentence_separator: str,
) -> Path:
    command = [
        sys.executable,
        str(SCRIPT_DIR / "render_transcript.py"),
        "--subtitle",
        str(subtitle_path),
        "--metadata",
        str(metadata_path),
        "--out-dir",
        str(output_dir),
        "--artifact-id",
        artifact_id,
        "--output-name",
        "transcript.md",
        "--sentences-per-group",
        str(sentences_per_group),
        "--sentence-separator",
        sentence_separator,
    ]
    subprocess.run(command, check=True)
    return output_dir / "transcript.md"


def save_status(
    output_dir: Path,
    artifact_id: str,
    response: Any,
    *,
    command: str,
    account_id: str | None,
    input_value: str,
    status: str,
) -> None:
    write_json(
        output_dir / "status.json",
        {
            "command": command,
            "status": status,
            "accountId": account_id,
            "input": redact_string(input_value),
            "response": response_metadata(response, input_value=input_value, transport="api"),
            "savedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        },
    )


def command_me(
    args: argparse.Namespace,
    token: str,
    account_id: str | None,
    registry_path: Path | None,
) -> None:
    status, response = request_json(args.base_url, "/v1/me", token, timeout=args.timeout, retries=args.retries)
    if status != 200:
        raise ApiError(status, response)
    update_registry_balance(registry_path, account_id, response)
    print(
        json.dumps(
            {
                "status": status,
                "accountId": account_id,
                "plan": response.get("plan") if isinstance(response, dict) else None,
                "remainingMinutes": remaining_minutes(response),
            },
            ensure_ascii=False,
        )
    )


def command_subtitle(
    args: argparse.Namespace,
    token: str,
    account_id: str | None,
    registry_path: Path | None,
) -> None:
    remaining_before = None
    # Availability check: always preflight /v1/me before content requests so an
    # exhausted or invalid key is reported before burning quota or time.
    _, remaining_before = preflight_account(args, token, account_id, registry_path)
    status, response = get_subtitle(args, token)
    if status != 200:
        raise ApiError(status, response)
    rows = normalize_subtitles(response)
    if not rows:
        raise SystemExit("字幕接口没有返回可识别字幕，停止并报告，不生成部分转录")
    artifact = write_response_artifacts(
        args.output_dir, args.input, response, transport="api"
    )
    subtitle_path = Path(artifact["subtitlePath"])
    metadata_path = Path(artifact["metadataPath"])
    artifact_id = str(artifact["artifactId"])
    artifact_dir = Path(artifact["artifactDir"])
    transcript_path = render_transcript(
        artifact_dir,
        artifact_id,
        subtitle_path,
        metadata_path,
        sentences_per_group=args.sentences_per_group,
        sentence_separator=args.sentence_separator,
    )
    update_registry_balance(
        registry_path,
        account_id,
        response,
        fallback_remaining_minutes=remaining_before,
    )
    save_status(
        artifact_dir,
        artifact_id,
        response,
        command=getattr(args, "requested_command", "subtitle"),
        account_id=account_id,
        input_value=args.input,
        status="transcript_ready",
    )
    readmes = write_artifact_readmes(
        args.output_dir,
        artifact,
        input_value=args.input,
        metadata=response_metadata(response, input_value=args.input, transport="api"),
    )
    print(
        json.dumps(
            {
                "status": status,
                "requestedCommand": getattr(args, "requested_command", "subtitle"),
                "mode": "subtitle-only",
                "synthesis": "codex-after-subtitle",
                "artifactId": artifact_id,
                "artifactDir": str(artifact_dir),
                "mainProduct": str(artifact["mainProductPath"]),
                "outputDir": str(args.output_dir),
                "transcript": str(transcript_path),
                "artifacts": {
                    "rawSubtitle": str(subtitle_path),
                    "metadata": str(metadata_path),
                    "status": str(artifact_dir / "status.json"),
                    "folderReadme": str(readmes["folderReadme"]),
                    "rootReadme": str(readmes["rootReadme"]),
                },
                "cueCount": len(rows),
                "response": response_metadata(response, input_value=args.input, transport="api"),
            },
            ensure_ascii=False,
        )
    )


def load_batch_input(path: Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8-sig") as handle:
        for line_number, raw_line in enumerate(handle, start=1):
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as error:
                raise SystemExit(f"批处理输入第 {line_number} 行不是合法 JSON：{error}") from error
            if isinstance(value, str):
                value = {"input": value}
            if not isinstance(value, dict):
                raise SystemExit(f"批处理输入第 {line_number} 行必须是输入字符串或对象")
            input_value = str(value.get("input") or value.get("url") or "").strip()
            if not input_value:
                raise SystemExit(f"批处理输入第 {line_number} 行缺少 input/url")
            records.append({**value, "input": input_value})
    return records


def source_key(input_value: str) -> str:
    bvid = re.search(r"(BV[0-9A-Za-z]+)", input_value)
    if bvid:
        return bvid.group(1)
    return input_value.rstrip("/")


def save_manifest(path: Path, manifest: dict[str, Any]) -> None:
    write_json(path, safe_json(manifest))


def load_manifest(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"version": 2, "operation": "getSubtitle", "items": {}}
    value = load_json(path)
    if not isinstance(value, dict) or not isinstance(value.get("items"), dict):
        raise SystemExit(f"批处理 manifest 格式不正确：{path}")
    return value


def artifact_location(output_dir: Path, input_value: str) -> Path | None:
    key = source_key(input_value)
    for metadata_path in output_dir.rglob("metadata.json"):
        try:
            metadata = load_json(metadata_path)
        except (OSError, json.JSONDecodeError):
            continue
        source = str(metadata.get("url") or metadata.get("sourceUrl") or "")
        if source and source_key(source) == key:
            return metadata_path.parent
    # Legacy long-name artifacts are deliberately not treated as a completed
    # cache hit: the next run should migrate the source to the compact layout.
    return None


def process_batch_item(
    args: argparse.Namespace,
    record: dict[str, Any],
    token: str,
    account_id: str | None,
    registry_path: Path | None,
) -> dict[str, Any]:
    input_value = record["input"]
    item_args = argparse.Namespace(**vars(args))
    item_args.input = input_value
    try:
        status, response = get_subtitle(item_args, token)
        if status != 200:
            raise ApiError(status, response)
        rows = normalize_subtitles(response)
        if not rows:
            raise SystemExit("字幕为空或结构不兼容")
        artifact = write_response_artifacts(
            args.output_dir, input_value, response, transport="api"
        )
        subtitle_path = Path(artifact["subtitlePath"])
        metadata_path = Path(artifact["metadataPath"])
        artifact_id = str(artifact["artifactId"])
        artifact_dir = Path(artifact["artifactDir"])
        transcript_path = render_transcript(
            artifact_dir,
            artifact_id,
            subtitle_path,
            metadata_path,
            sentences_per_group=args.sentences_per_group,
            sentence_separator=args.sentence_separator,
        )
        save_status(
            artifact_dir,
            artifact_id,
            response,
            command="batch",
            account_id=account_id,
            input_value=input_value,
            status="transcript_ready",
        )
        update_registry_balance(registry_path, account_id, response)
        readmes = write_artifact_readmes(
            args.output_dir,
            artifact,
            input_value=input_value,
            metadata=response_metadata(response, input_value=input_value, transport="api"),
        )
        result = {
            "key": source_key(input_value),
            "input": input_value,
            "status": "transcript_ready",
            "operation": "getSubtitle",
            "artifactId": artifact_id,
            "artifactDir": str(artifact_dir),
            "mainProduct": str(artifact["mainProductPath"]),
            "transcript": str(transcript_path),
            "artifacts": {
                "rawSubtitle": str(subtitle_path),
                "metadata": str(metadata_path),
                "status": str(artifact_dir / "status.json"),
                "folderReadme": str(readmes["folderReadme"]),
                "rootReadme": str(readmes["rootReadme"]),
            },
            "cueCount": len(rows),
            "response": response_metadata(response, input_value=input_value, transport="api"),
        }
        return result
    except ApiError as error:
        status = {
            401: "auth_error",
            402: "quota_exhausted",
            403: "auth_error",
            429: "rate_limited",
        }.get(
            error.status,
            "retryable_error" if error.status == 0 or error.status >= 500 else "manual_review",
        )
        return {
            "key": source_key(input_value),
            "input": input_value,
            "status": status,
            "httpStatus": error.status,
            "error": error.detail,
        }
    except (SystemExit, OSError, subprocess.CalledProcessError) as error:
        return {
            "key": source_key(input_value),
            "input": input_value,
            "status": "manual_review",
            "error": str(error),
        }


def command_batch(
    args: argparse.Namespace,
    token: str,
    account_id: str | None,
    registry_path: Path | None,
) -> None:
    records = load_batch_input(args.input_file)
    unique: list[dict[str, Any]] = []
    seen: set[str] = set()
    for record in records:
        key = source_key(record["input"])
        if key not in seen:
            seen.add(key)
            unique.append(record)

    args.output_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = args.manifest or args.output_dir / "batch-manifest.json"
    manifest = load_manifest(manifest_path)
    manifest.update(
        {
            "version": 2,
            "operation": "getSubtitle",
            "input": str(args.input_file),
            "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
    )
    save_manifest(manifest_path, manifest)

    remaining_before = None
    # Availability check: always preflight /v1/me before batch content requests.
    _, remaining_before = preflight_account(args, token, account_id, registry_path)
    print(
        json.dumps(
            {
                "event": "batch_preflight",
                "count": len(unique),
                "operation": "getSubtitle",
                "accountId": account_id,
                "remainingMinutes": remaining_before,
            },
            ensure_ascii=False,
        )
    )

    processed = skipped = failed = 0
    stopped = None
    for record in unique:
        key = source_key(record["input"])
        existing = manifest["items"].get(key)
        if (
            not args.refresh
            and isinstance(existing, dict)
            and existing.get("status") == "transcript_ready"
            and artifact_location(args.output_dir, record["input"])
        ):
            skipped += 1
            print(json.dumps({"event": "skip_cached", "key": key}, ensure_ascii=False))
            continue
        started = time.time()
        result = process_batch_item(args, record, token, account_id, registry_path)
        result["elapsedSeconds"] = round(time.time() - started, 2)
        manifest["items"][key] = result
        manifest["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        write_json(manifest_path, safe_json(manifest))
        print(json.dumps({"event": "item", **safe_json(result)}, ensure_ascii=False))
        if result.get("status") == "transcript_ready":
            processed += 1
        else:
            failed += 1
        if result.get("status") in {"auth_error", "quota_exhausted", "rate_limited"}:
            stopped = result["status"]
            break

    print(
        json.dumps(
            {
                "event": "batch_complete",
                "operation": "getSubtitle",
                "inputCount": len(records),
                "uniqueCount": len(unique),
                "processed": processed,
                "skippedCached": skipped,
                "failed": failed,
                "stopped": stopped,
                "remainingMinutesBefore": remaining_before,
                "manifest": str(manifest_path),
                "nextStep": "Codex 可基于已生成字幕按需总结、比较或生成学习文档",
            },
            ensure_ascii=False,
        )
    )


def add_common(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--token-env", help="显式指定其他环境变量名；默认读取 BIBI_API_TOKEN")
    parser.add_argument("--registry", type=Path, help="显式指定项目级 accounts.json 或旧名 accounts-tokens.json")
    parser.add_argument("--env-file", type=Path, help="指定项目 .env；默认从当前目录向上查找")
    parser.add_argument("--account-id")
    parser.add_argument("--minimum-minutes", type=float)
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--timeout", type=int, default=90)
    parser.add_argument("--retries", type=int, default=2)
    parser.add_argument("--preflight", action="store_true", help="先调用 /v1/me 检查 API 余额")


def add_media_args(parser: argparse.ArgumentParser) -> None:
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--input", dest="input", help="媒体 URL；API 模式也接受公开媒体 URL")
    group.add_argument("--url", dest="input", help="兼容旧命令的 URL 参数")
    parser.add_argument("--output-dir", type=Path, default=Path("./media-artifacts"))
    parser.add_argument("--audio-language")
    parser.add_argument("--enabled-speaker", action="store_true")
    parser.add_argument("--transcribe-provider")
    parser.add_argument("--whisper-prompt")
    parser.add_argument("--sentences-per-group", type=int, default=10)
    parser.add_argument(
        "--sentence-separator",
        default="linebreak",
        help="cue 分隔方式：默认 linebreak；也支持 |、space 或自定义字符串",
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="只调用 BibiGPT getSubtitle 获取字幕；总结由 Codex 在字幕之后完成"
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    me = subparsers.add_parser("me", help="查询 API 账号和剩余分钟")
    add_common(me)
    me.set_defaults(handler=command_me, requested_command="me")

    subtitle = subparsers.add_parser("subtitle", help="获取字幕并生成时间轴转录")
    add_common(subtitle)
    add_media_args(subtitle)
    subtitle.set_defaults(handler=command_subtitle, requested_command="subtitle")

    # Compatibility aliases: they now intentionally use the subtitle-only path.
    for alias in ("summary", "hybrid"):
        legacy = subparsers.add_parser(alias, help="兼容旧命令：仍只获取字幕")
        add_common(legacy)
        add_media_args(legacy)
        legacy.add_argument("--custom-prompt", help=argparse.SUPPRESS)
        legacy.add_argument("--output-language", help=argparse.SUPPRESS)
        legacy.add_argument("--detail-level", type=int, help=argparse.SUPPRESS)
        legacy.set_defaults(handler=command_subtitle, requested_command=alias)

    batch = subparsers.add_parser("batch", help="串行批量获取字幕；单 Token、可恢复、不自动轮换")
    add_common(batch)
    batch.add_argument("--input", dest="input_file", required=True, type=Path, help="JSONL：每行 URL/文件字符串或 {\"input\": ...}")
    batch.add_argument("--output-dir", type=Path, default=Path("./media-artifacts"))
    batch.add_argument("--manifest", type=Path)
    batch.add_argument("--refresh", action="store_true", help="忽略已完成字幕缓存")
    batch.add_argument("--audio-language")
    batch.add_argument("--enabled-speaker", action="store_true")
    batch.add_argument("--transcribe-provider")
    batch.add_argument("--whisper-prompt")
    batch.add_argument("--sentences-per-group", type=int, default=10)
    batch.add_argument(
        "--sentence-separator",
        default="linebreak",
        help="cue 分隔方式：默认 linebreak；也支持 |、space 或自定义字符串",
    )
    batch.set_defaults(handler=command_batch, requested_command="batch")
    return parser


def main() -> None:
    args = build_parser().parse_args()
    try:
        token, account_id, registry_path = resolve_token(args)
        args.handler(args, token, account_id, registry_path)
    except ApiError as error:
        action = {
            401: "更新当前授权 Token，不自动切换账号",
            402: "检查 API 余额/计费，不自动绕过",
            403: "检查权限或额度，不自动绕过",
            404: "检查媒体 URL 或资源是否存在",
            429: "降低频率并遵循 Retry-After",
        }.get(error.status, "检查请求参数或服务状态")
        print(
            json.dumps(
                {
                    "ok": False,
                    "status": error.status,
                    "error": error.detail,
                    "retryAfter": error.retry_after,
                    "action": action,
                },
                ensure_ascii=False,
            ),
            file=sys.stderr,
        )
        raise SystemExit(2)


if __name__ == "__main__":
    main()
