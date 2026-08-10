#!/usr/bin/env python3
"""Maintain a local registry of manually authorized BibiGPT API tokens.

The registry is intentionally project-local, never skill-local.  The project
.env stores only a pointer to the registry; the registry itself is kept as a
0600 JSON file because it may contain plaintext tokens.  This utility is not an
account creator, cookie collector, token rotator, or quota bypass.
"""

from __future__ import annotations

import argparse
import getpass
import json
import math
import os
import re
import secrets
import sys
from pathlib import Path
from typing import Any

ENV_REGISTRY_KEY = "BIBIGPT_TOKEN_REGISTRY"
ENV_TOKEN_KEY = "BIBI_API_TOKEN"
DEFAULT_ACCOUNTS_FILE = "accounts.json"
LEGACY_ACCOUNTS_FILE = "accounts-tokens.json"


def empty_account(account_id: str) -> dict[str, Any]:
    return {
        "id": account_id,
        "api_token": None,
        "remaining_minutes": 0,
    }


def normalize_registry(value: dict[str, Any]) -> dict[str, Any]:
    """Keep only runtime credential fields in every account record.

    ``remaining_minutes: null`` means the balance is unknown and must be
    checked with ``/v1/me`` before the content request.  This is important for
    a newly imported token: it must not be mistaken for an exhausted token.
    """
    accounts = value.get("accounts")
    if not isinstance(accounts, list):
        raise SystemExit("registry 格式无效：需要包含 accounts 数组")
    normalized: list[dict[str, Any]] = []
    seen: set[str] = set()
    for account in accounts:
        if not isinstance(account, dict) or not account.get("id"):
            raise SystemExit("registry 格式无效：每个账号需要 id")
        account_id = str(account["id"])
        if account_id in seen:
            raise SystemExit(f"registry 中存在重复账号 ID：{account_id}")
        seen.add(account_id)

        token = account.get("api_token")
        if token is not None:
            token = str(token).strip() or None
            if token and any(char.isspace() for char in token):
                raise SystemExit(f"账号 Token 不应包含空白字符：{account_id}")

        # Empty slots should remain explicitly unknown so a later preflight can
        # decide whether a newly imported/manual token is usable.
        raw_remaining = account.get("remaining_minutes", None)
        if raw_remaining is None:
            remaining: float | None = None
        else:
            try:
                remaining = float(raw_remaining)
            except (TypeError, ValueError) as error:
                raise SystemExit(
                    f"账号 remaining_minutes 无效：{account_id}"
                ) from error
            if not math.isfinite(remaining) or remaining < 0:
                raise SystemExit(f"账号 remaining_minutes 无效：{account_id}")

        compact: dict[str, Any] = {
            "id": account_id,
            "api_token": token,
            "remaining_minutes": remaining,
        }
        if account.get("label") is not None:
            compact["label"] = str(account["label"])
        normalized.append(compact)
    value["accounts"] = normalized
    return value


def new_registry(slots: int) -> dict[str, Any]:
    return {
        "schemaVersion": 2,
        "simulationOnly": False,
        "networkAccess": "api-only",
        "provider": "bibigpt",
        "note": (
            "User-authorized BibiGPT API tokens. Select the first token in "
            "registry order with positive remaining_minutes; null means "
            "unknown and is checked once with /v1/me. Stop on auth, quota, "
            "or rate-limit errors; do not rotate automatically."
        ),
        "selection": {
            "order": "registry",
            "requiresPositiveRemainingMinutes": True,
            "unknownBalanceRequiresPreflight": True,
            "rotateAfterError": False,
        },
        "accounts": [
            empty_account(f"account-{index:02d}") for index in range(1, slots + 1)
        ],
    }


def load_registry(path: Path) -> dict[str, Any]:
    require_private_registry(path)
    try:
        with path.open("r", encoding="utf-8-sig") as handle:
            value = json.load(handle)
    except FileNotFoundError as error:
        raise SystemExit(f"找不到 registry：{path}") from error
    except json.JSONDecodeError as error:
        raise SystemExit(f"registry 不是合法 JSON：{path}") from error
    if not isinstance(value, dict):
        raise SystemExit("registry 格式无效：需要包含 accounts 数组")
    return normalize_registry(value)


def save_registry(path: Path, value: dict[str, Any]) -> None:
    value = normalize_registry(value)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{secrets.token_hex(4)}.tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    os.chmod(temporary, 0o600)
    temporary.replace(path)
    os.chmod(path, 0o600)


def require_private_registry(path: Path) -> None:
    """Refuse to use a registry that is group/world accessible."""
    if not path.exists():
        return
    if os.name == "nt":
        # Windows has no POSIX mode bits; chmod is best-effort and the ACL is
        # managed by the user/project, so skip the mode check there.
        return
    mode = path.stat().st_mode & 0o777
    if mode & 0o077:
        raise SystemExit(
            f"registry 权限过宽（{oct(mode)}）：请先 chmod 600 {path}"
        )


def discover_dotenv(start_dir: Path | None = None) -> Path | None:
    """Find the nearest project .env from cwd, walking toward the filesystem root."""
    base = (start_dir or Path.cwd()).expanduser().resolve()
    if base.is_file():
        base = base.parent
    for parent in (base, *base.parents):
        candidate = parent / ".env"
        if candidate.exists():
            return candidate
    return None


def read_dotenv_value(path: Path, key: str) -> str | None:
    """Read one simple dotenv assignment without importing a dotenv package."""
    if not path.exists():
        return None
    pattern = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$")
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        match = pattern.match(raw_line)
        if not match or match.group(1) != key:
            continue
        value = match.group(2).strip()
        if len(value) >= 2 and value[0] == value[-1] == '"':
            try:
                return str(json.loads(value))
            except json.JSONDecodeError:
                return value[1:-1]
        if len(value) >= 2 and value[0] == value[-1] == "'":
            return value[1:-1]
        # Treat an unquoted inline comment as a comment, but keep # in a path
        # when it is not preceded by whitespace.
        return re.split(r"\s+#", value, maxsplit=1)[0].strip()
    return None


def resolve_path_reference(reference: str | Path, *, base_dir: Path | None = None) -> Path:
    path = Path(reference).expanduser()
    if not path.is_absolute():
        path = (base_dir or Path.cwd()) / path
    return path.resolve(strict=False)


def dotenv_value(value: str) -> str:
    if re.search(r"[\s#\"']", value):
        return json.dumps(value, ensure_ascii=False)
    return value


def write_env_pointer(env_file: Path, registry_path: Path) -> None:
    """Write only the registry path to .env, never the token itself."""
    env_file = env_file.expanduser().resolve(strict=False)
    registry_path = registry_path.expanduser().resolve(strict=False)
    env_file.parent.mkdir(parents=True, exist_ok=True)
    try:
        reference = os.path.relpath(registry_path, env_file.parent)
    except ValueError:
        reference = str(registry_path)
    if not reference.startswith("."):
        reference = "./" + reference

    lines = env_file.read_text(encoding="utf-8").splitlines() if env_file.exists() else []
    assignment = f"{ENV_REGISTRY_KEY}={dotenv_value(reference)}"
    pattern = re.compile(rf"^\s*(?:export\s+)?{re.escape(ENV_REGISTRY_KEY)}\s*=")
    replaced = False
    output: list[str] = []
    for line in lines:
        if pattern.match(line):
            if not replaced:
                output.append(assignment)
                replaced = True
            continue
        output.append(line)
    if not replaced:
        if output and output[-1].strip():
            output.append("")
        output.append(assignment)

    temporary = env_file.with_name(f".{env_file.name}.{secrets.token_hex(4)}.tmp")
    temporary.write_text("\n".join(output).rstrip() + "\n", encoding="utf-8")
    os.chmod(temporary, 0o600)
    temporary.replace(env_file)
    os.chmod(env_file, 0o600)


def registry_path_from_env(env_file: Path | None) -> Path | None:
    if env_file is None:
        return None
    reference = read_dotenv_value(env_file, ENV_REGISTRY_KEY)
    if not reference:
        return None
    return resolve_path_reference(reference, base_dir=env_file.parent)


def default_registry_path(env_file: Path | None = None) -> Path:
    base = env_file.parent if env_file else Path.cwd()
    return (base / DEFAULT_ACCOUNTS_FILE).resolve(strict=False)


def discover_accounts_file(env_file: Path | None) -> Path | None:
    """Find the accounts file: explicit pointer, then accounts.json, then legacy name."""
    if env_file:
        reference = read_dotenv_value(env_file, ENV_REGISTRY_KEY)
        if reference:
            return resolve_path_reference(reference, base_dir=env_file.parent)
    process_value = os.environ.get(ENV_REGISTRY_KEY, "").strip()
    if process_value:
        return resolve_path_reference(process_value)
    base = env_file.parent if env_file else Path.cwd()
    for name in (DEFAULT_ACCOUNTS_FILE, LEGACY_ACCOUNTS_FILE):
        candidate = (base / name).resolve(strict=False)
        if candidate.exists():
            return candidate
    return None


def find_account(registry: dict[str, Any], account_id: str) -> dict[str, Any]:
    for account in registry["accounts"]:
        if isinstance(account, dict) and account.get("id") == account_id:
            return account
    raise SystemExit(f"找不到账号槽位：{account_id}")


def first_empty_account(registry: dict[str, Any]) -> dict[str, Any]:
    for account in registry["accounts"]:
        if isinstance(account, dict) and not str(account.get("api_token") or "").strip():
            return account
    raise SystemExit("registry 没有空账号槽位；请使用 add 或显式 --replace")


def read_token(args: argparse.Namespace) -> str:
    token = sys.stdin.read().strip() if args.token_stdin else getpass.getpass("BibiGPT API Token（输入不会显示）: ").strip()
    if not token:
        raise SystemExit("未读取到 Token")
    if any(char.isspace() for char in token):
        raise SystemExit("Token 不应包含空白字符")
    return token


def require_plaintext_ack(args: argparse.Namespace) -> None:
    if not args.acknowledge_plaintext_token_storage:
        raise SystemExit(
            "Token 将以 0600 权限保存到项目 registry；如确认，请显式提供 "
            "--acknowledge-plaintext-token-storage"
        )


def command_init(args: argparse.Namespace) -> None:
    if args.registry.exists() and not args.force:
        raise SystemExit(
            f"文件已存在：{args.registry}；如需覆盖请显式使用 --force"
        )
    if args.slots < 1 or args.slots > 100:
        raise SystemExit("--slots 必须在 1 到 100 之间")
    save_registry(args.registry.resolve(strict=False), new_registry(args.slots))
    print(json.dumps({"created": str(args.registry.resolve()), "slots": args.slots}, ensure_ascii=False))


def command_bind(args: argparse.Namespace, *, emit: bool = True) -> dict[str, Any]:
    registry_path = args.registry.resolve(strict=False)
    env_file = args.env_file.resolve(strict=False)
    if not registry_path.exists():
        raise SystemExit(f"找不到 registry：{registry_path}；先导入 Token 或检查路径")
    load_registry(registry_path)
    write_env_pointer(env_file, registry_path)
    result = {
        "bound": True,
        "registry": str(registry_path),
        "envFile": str(env_file),
        "tokenStored": False,
    }
    if emit:
        print(json.dumps(result, ensure_ascii=False))
    return result


def command_repair(args: argparse.Namespace, *, emit: bool = True) -> dict[str, Any]:
    """Repair only the .env pointer, or initialize a new project registry."""
    env_file = (args.env_file or Path.cwd() / ".env").expanduser().resolve(strict=False)
    registry_path = (args.registry or default_registry_path(env_file)).expanduser().resolve(strict=False)
    if registry_path.exists():
        load_registry(registry_path)
        write_env_pointer(env_file, registry_path)
        result = {
            "repaired": True,
            "mode": "bind-existing",
            "registry": str(registry_path),
            "envFile": str(env_file),
            "tokenStored": False,
        }
        if emit:
            print(json.dumps(result, ensure_ascii=False))
        return result
    if args.no_prompt:
        raise SystemExit(
            f"找不到 registry：{registry_path}；请提供已有 registry，或允许交互式导入 Token"
        )
    require_plaintext_ack(args)
    if args.slots < 1 or args.slots > 100:
        raise SystemExit("--slots 必须在 1 到 100 之间")
    registry = new_registry(args.slots)
    account = registry["accounts"][0]
    token = read_token(args)
    account["api_token"] = token
    account["remaining_minutes"] = None
    save_registry(registry_path, registry)
    write_env_pointer(env_file, registry_path)
    result = {
        "repaired": True,
        "mode": "initialized",
        "registry": str(registry_path),
        "envFile": str(env_file),
        "accountId": account["id"],
        "tokenStored": True,
        "tokenPrinted": False,
    }
    if emit:
        print(json.dumps(result, ensure_ascii=False))
    return result


def command_setup(args: argparse.Namespace, *, emit: bool = True) -> dict[str, Any]:
    require_plaintext_ack(args)
    # Setup writes to the current project by default.  Auto-discovery is used
    # by the acquisition client, not to accidentally modify a parent project.
    env_file = (args.env_file or Path.cwd() / ".env").expanduser().resolve(strict=False)
    registry_path = (args.registry or default_registry_path(env_file)).expanduser().resolve(strict=False)

    if registry_path.exists():
        registry = load_registry(registry_path)
    else:
        if args.slots < 1 or args.slots > 100:
            raise SystemExit("--slots 必须在 1 到 100 之间")
        registry = new_registry(args.slots)

    account = find_account(registry, args.account_id) if args.account_id else first_empty_account(registry)
    if account.get("api_token") and not args.replace:
        raise SystemExit(
            f"账号槽位已有 Token：{account.get('id')}；如需替换请显式使用 --replace，"
            "已有 registry 只绑定 .env 请使用 bind"
        )
    token = read_token(args)
    account["api_token"] = token
    # Unknown until the first /v1/me preflight; do not write 0 here.
    account["remaining_minutes"] = None
    if args.label is not None:
        account["label"] = args.label
    save_registry(registry_path, registry)
    write_env_pointer(env_file, registry_path)
    result = {
        "initialized": True,
        "registry": str(registry_path),
        "envFile": str(env_file),
        "accountId": account.get("id"),
        "tokenStored": True,
        "tokenPrinted": False,
    }
    if emit:
        print(json.dumps(result, ensure_ascii=False))
    return result


def command_add(args: argparse.Namespace) -> None:
    require_plaintext_ack(args)
    registry_path = args.registry.resolve(strict=False)
    registry = load_registry(registry_path)
    account = find_account(registry, args.account_id)
    if account.get("api_token") and not args.replace:
        raise SystemExit("该槽位已有 Token；如需替换请显式使用 --replace")

    account["api_token"] = read_token(args)
    account["remaining_minutes"] = None
    if args.label is not None:
        account["label"] = args.label
    save_registry(registry_path, registry)
    print(
        json.dumps(
            {
                "updated": args.account_id,
                "tokenStored": True,
                "tokenPrinted": False,
                "pathMode": "project-registry-0600",
                "balance": "unknown-until-preflight",
            },
            ensure_ascii=False,
        )
    )


def command_list(args: argparse.Namespace) -> None:
    registry = load_registry(args.registry.resolve(strict=False))
    accounts = []
    for account in registry["accounts"]:
        if not isinstance(account, dict):
            continue
        accounts.append(
            {
                "id": account.get("id"),
                "label": account.get("label"),
                "hasToken": bool(account.get("api_token")),
                "remainingMinutes": account.get("remaining_minutes"),
            }
        )
    print(
        json.dumps(
            {"provider": registry.get("provider"), "accounts": accounts},
            ensure_ascii=False,
            indent=2,
        )
    )


def command_disable(args: argparse.Namespace) -> None:
    registry_path = args.registry.resolve(strict=False)
    registry = load_registry(registry_path)
    account = find_account(registry, args.account_id)
    account["api_token"] = None
    account["remaining_minutes"] = 0
    save_registry(registry_path, registry)
    print(
        json.dumps(
            {"disabled": args.account_id, "tokenCleared": True},
            ensure_ascii=False,
        )
    )


def parse_tokens_input(path: Path) -> list[str]:
    """Read tokens from a newline-separated text file or an accounts JSON file."""
    text = path.read_text(encoding="utf-8-sig")
    stripped = text.lstrip()
    if stripped.startswith("{"):
        try:
            value = json.loads(text)
        except json.JSONDecodeError as error:
            raise SystemExit(f"JSON 输入不是合法 JSON：{path}：{error}") from error
        accounts = value.get("accounts") if isinstance(value, dict) else None
        if not isinstance(accounts, list):
            raise SystemExit("JSON 输入需要包含 accounts 数组")
        tokens = []
        for account in accounts:
            if not isinstance(account, dict):
                continue
            token = str(account.get("api_token") or "").strip()
            if token:
                if any(char.isspace() for char in token):
                    raise SystemExit("JSON 输入中的 Token 不应包含空白字符")
                tokens.append(token)
        if not tokens:
            raise SystemExit("JSON 输入中没有可用 api_token")
        return tokens

    tokens = []
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if any(char.isspace() for char in line):
            raise SystemExit("文本输入每行只能包含一个 Token，且 Token 不应包含空白字符")
        tokens.append(line)
    if not tokens:
        raise SystemExit("输入文件没有读取到任何 Token")
    return tokens


def command_import(args: argparse.Namespace) -> None:
    """Batch-import tokens from a newline-separated file or an accounts JSON file."""
    require_plaintext_ack(args)
    env_file = (args.env_file or Path.cwd() / ".env").expanduser().resolve(strict=False)
    registry_path = (args.registry or default_registry_path(env_file)).expanduser().resolve(strict=False)
    input_path = args.input.expanduser().resolve(strict=False)
    if not input_path.exists():
        raise SystemExit(f"找不到输入文件：{input_path}")

    tokens = parse_tokens_input(input_path)
    registry = load_registry(registry_path) if registry_path.exists() else new_registry(0)
    existing = {
        str(account.get("api_token") or "").strip()
        for account in registry.get("accounts", [])
        if isinstance(account, dict) and str(account.get("api_token") or "").strip()
    }
    imported: list[str] = []
    skipped = 0
    for token in tokens:
        if token in existing:
            skipped += 1
            continue
        try:
            account = first_empty_account(registry)
        except SystemExit:
            next_index = len(registry.get("accounts", [])) + 1
            account = empty_account(f"account-{next_index:02d}")
            registry.setdefault("accounts", []).append(account)
        account["api_token"] = token
        account["remaining_minutes"] = None
        imported.append(account["id"])
        existing.add(token)

    if imported:
        save_registry(registry_path, registry)
        write_env_pointer(env_file, registry_path)
    print(
        json.dumps(
            {
                "imported": len(imported),
                "skippedDuplicates": skipped,
                "registry": str(registry_path),
                "envFile": str(env_file),
                "accountIds": imported,
                "tokenStored": bool(imported),
                "tokenPrinted": False,
                "acknowledgedPlaintext": True,
            },
            ensure_ascii=False,
        )
    )


def command_check(args: argparse.Namespace) -> None:
    """Availability check: report key sources and cached balances without printing tokens."""
    env_file = args.env_file.expanduser().resolve(strict=False) if getattr(args, "env_file", None) else discover_dotenv()
    sources = [
        {
            "kind": "env",
            "path": None,
            "hasToken": bool(os.environ.get(ENV_TOKEN_KEY, "").strip()),
            "accountId": None,
            "remainingMinutes": None,
        },
        {
            "kind": "dotenv",
            "path": str(env_file) if env_file else None,
            "hasToken": bool(read_dotenv_value(env_file, ENV_TOKEN_KEY)) if env_file else False,
            "accountId": None,
            "remainingMinutes": None,
        },
    ]
    accounts_file = discover_accounts_file(env_file)
    accounts_info: list[dict[str, Any]] = []
    if accounts_file:
        try:
            registry = load_registry(accounts_file)
        except (SystemExit, OSError):
            registry = {"accounts": []}
        for account in registry.get("accounts", []):
            if not isinstance(account, dict):
                continue
            accounts_info.append(
                {
                    "id": account.get("id"),
                    "hasToken": bool(str(account.get("api_token") or "").strip()),
                    "remainingMinutes": account.get("remaining_minutes"),
                }
            )
    sources.append(
        {
            "kind": "accounts-file",
            "path": str(accounts_file) if accounts_file else None,
            "accounts": accounts_info,
        }
    )
    print(json.dumps({"sources": sources}, ensure_ascii=False, indent=2))


def add_token_input_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--token-stdin", action="store_true", help="从 stdin 读取 Token；默认使用隐藏提示")
    parser.add_argument("--label")
    parser.add_argument("--replace", action="store_true")
    parser.add_argument("--acknowledge-plaintext-token-storage", action="store_true")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="维护项目级、0600 保护的 BibiGPT API Token 账号文件")
    subparsers = parser.add_subparsers(dest="command", required=True)

    init = subparsers.add_parser("init", help="创建空账号槽位")
    init.add_argument("--registry", type=Path, required=True)
    init.add_argument("--slots", type=int, default=20)
    init.add_argument("--force", action="store_true")
    init.set_defaults(func=command_init)

    setup = subparsers.add_parser("setup", help="首次使用：隐藏输入 Token，并绑定项目 .env")
    setup.add_argument("--registry", type=Path)
    setup.add_argument("--env-file", type=Path)
    setup.add_argument("--slots", type=int, default=1)
    setup.add_argument("--account-id")
    add_token_input_args(setup)
    setup.set_defaults(func=command_setup)

    bind = subparsers.add_parser("bind", help="已有账号文件时只把路径写入项目 .env")
    bind.add_argument("--registry", type=Path, required=True)
    bind.add_argument("--env-file", type=Path, default=Path(".env"))
    bind.set_defaults(func=command_bind)

    repair = subparsers.add_parser("repair", help="修复项目 .env 指针；缺失时可交互式导入 Token")
    repair.add_argument("--registry", type=Path)
    repair.add_argument("--env-file", type=Path)
    repair.add_argument("--slots", type=int, default=1)
    repair.add_argument("--token-stdin", action="store_true")
    repair.add_argument("--acknowledge-plaintext-token-storage", action="store_true")
    repair.add_argument("--no-prompt", action="store_true", help="缺失 registry 时只报错，不读取 Token")
    repair.set_defaults(func=command_repair)

    add = subparsers.add_parser("add", help="向已有账号文件录入一个已授权 Token")
    add.add_argument("--registry", type=Path, required=True)
    add.add_argument("--account-id", required=True)
    add_token_input_args(add)
    add.set_defaults(func=command_add)

    import_cmd = subparsers.add_parser(
        "import",
        help="批量导入：从换行分隔文本文件或 accounts JSON 导入多个 Token",
    )
    import_cmd.add_argument("--registry", type=Path)
    import_cmd.add_argument("--env-file", type=Path)
    import_cmd.add_argument("--input", type=Path, required=True, help="输入文件：每行一个 key，或 accounts JSON 格式")
    import_cmd.add_argument("--acknowledge-plaintext-token-storage", action="store_true")
    import_cmd.set_defaults(func=command_import)

    check_cmd = subparsers.add_parser("check", help="可用性检查：报告 key 来源与缓存余额，不输出 Token")
    check_cmd.add_argument("--env-file", type=Path)
    check_cmd.set_defaults(func=command_check)

    list_command = subparsers.add_parser("list", help="列出状态，不输出 Token")
    list_command.add_argument("--registry", type=Path, required=True)
    list_command.set_defaults(func=command_list)

    disable = subparsers.add_parser("disable", help="清空一个槽位的 Token 和余额")
    disable.add_argument("--registry", type=Path, required=True)
    disable.add_argument("--account-id", required=True)
    disable.set_defaults(func=command_disable)
    return parser


if __name__ == "__main__":
    parser = build_parser()
    command_args = parser.parse_args()
    command_args.func(command_args)
