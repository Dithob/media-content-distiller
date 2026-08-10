#!/usr/bin/env python3
"""Offline repository checks for the media-content-distiller skill."""

from __future__ import annotations

import json
import os
import re
import stat
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"


def fail(message: str) -> None:
    raise SystemExit(f"VERIFY_FAIL: {message}")


def require_file(relative: str) -> Path:
    path = ROOT / relative
    if not path.is_file():
        fail(f"missing file: {relative}")
    return path


def parse_frontmatter(path: Path) -> dict[str, object]:
    text = path.read_text(encoding="utf-8")
    match = re.match(r"^---\n(.*?)\n---\n", text, re.DOTALL)
    if not match:
        fail("SKILL.md does not have YAML frontmatter")

    values: dict[str, object] = {}
    for line in match.group(1).splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        key, separator, raw_value = line.partition(":")
        if not separator:
            fail(f"invalid frontmatter line: {line}")
        value = raw_value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        values[key.strip()] = value

    for key in ("name", "description"):
        if not isinstance(values.get(key), str) or not str(values[key]).strip():
            fail(f"missing frontmatter key: {key}")
    name = str(values["name"])
    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", name):
        fail("skill name is not hyphen-case")
    if len(name) > 64:
        fail("skill name is too long")
    description = str(values["description"])
    if len(description) > 1024 or "<" in description or ">" in description:
        fail("skill description violates frontmatter constraints")
    return values


def parse_openai_yaml(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    if not text.startswith("interface:\n"):
        fail("agents/openai.yaml must start with interface:")
    required = ("display_name:", "short_description:", "default_prompt:")
    for key in required:
        if key not in text:
            fail(f"agents/openai.yaml missing {key}")
    prompt_match = re.search(r'^  default_prompt:\s*["\']?(.*?)["\']?\s*$', text, re.MULTILINE)
    if not prompt_match or "$media-content-distiller" not in prompt_match.group(1):
        fail("default_prompt must explicitly mention $media-content-distiller")
    short_match = re.search(r'^  short_description:\s*["\']?(.*?)["\']?\s*$', text, re.MULTILINE)
    if short_match and not 25 <= len(short_match.group(1)) <= 64:
        fail("short_description must be 25-64 characters")


def check_no_secrets() -> None:
    secret_pattern = re.compile(
        r"(?:sk-[A-Za-z0-9_-]{12,}|(?:api[_-]?key|password)\s*[:=]\s*['\"]?[A-Za-z0-9_./+=-]{16,})",
        re.IGNORECASE,
    )
    for path in ROOT.rglob("*"):
        if not path.is_file() or ".git" in path.parts or "__pycache__" in path.parts:
            continue
        if path.name in {"verify_skill.py", ".env.example"}:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        if secret_pattern.search(text):
            fail(f"possible secret in {path.relative_to(ROOT)}")


def run(*args: str, expect: int = 0, env: dict[str, str] | None = None) -> str:
    proc = subprocess.run(
        args,
        cwd=ROOT,
        text=True,
        capture_output=True,
        env=env,
    )
    if proc.returncode != expect:
        fail(
            f"command failed ({proc.returncode} != {expect}): {' '.join(args)}\n"
            f"{proc.stdout}{proc.stderr}"
        )
    return proc.stdout


def test_local_subtitles() -> None:
    fixture = {
        "detail": {
            "title": "离线字幕验证",
            "url": "https://example.invalid/video",
            "duration": 12,
            "subtitlesArray": [
                {"index": 0, "startTime": 0, "endTime": 1.5, "text": "第一句"},
                {"index": 1, "startTime": 2, "endTime": 3.5, "text": "第二句"},
                {"index": 2, "startTime": 4, "endTime": 5.5, "text": "第三句"},
            ],
        }
    }
    with tempfile.TemporaryDirectory() as temp_dir:
        temp = Path(temp_dir)
        raw = temp / "raw.json"
        meta = temp / "metadata.json"
        out_dir = temp / "artifacts" / "source-id"
        raw.write_text(json.dumps(fixture, ensure_ascii=False), encoding="utf-8")
        meta.write_text(json.dumps(fixture["detail"], ensure_ascii=False), encoding="utf-8")

        normalized = run(sys.executable, "scripts/normalize_subtitle.py", "--input", str(raw))
        rows = json.loads(normalized)
        if len(rows) != 3 or rows[1]["start"] != 2.0:
            fail("subtitle normalization did not preserve fixture cues")

        run(
            sys.executable,
            "scripts/render_transcript.py",
            "--subtitle",
            str(raw),
            "--metadata",
            str(meta),
            "--out-dir",
            str(out_dir),
            "--artifact-id",
            "source-id",
            "--sentences-per-group",
            "2",
        )
        transcript = (out_dir / "transcript.md").read_text(encoding="utf-8")
        if "第一句\n第二句" not in transcript or "第一句第二句" in transcript:
            fail("grouped transcript did not keep cue boundaries readable")
        if "〔句间分隔〕" in transcript:
            fail("default transcript contains an unexpected placeholder separator")


def test_redaction() -> None:
    spec = __import__("importlib.util").util.spec_from_file_location(
        "acquire_subtitle", SCRIPTS / "acquire_subtitle.py"
    )
    if spec is None or spec.loader is None:
        fail("could not import acquire_subtitle.py")
    module = __import__("importlib.util").util.module_from_spec(spec)
    sys.path.insert(0, str(SCRIPTS))
    try:
        spec.loader.exec_module(module)
    finally:
        sys.path.pop(0)
    value = module.safe_json(
        {
            "Authorization": "Bearer secret-token-value",
            "nested": {"api_token": "another-secret"},
            "url": "https://example.invalid/?token=secret-token-value",
        }
    )
    text = json.dumps(value, ensure_ascii=False)
    if "secret-token-value" in text or "another-secret" in text:
        fail("credential redaction leaked a secret-shaped value")
    if "[REDACTED]" not in text:
        fail("credential redaction marker missing")


def test_registry_permissions() -> None:
    with tempfile.TemporaryDirectory() as temp_dir:
        temp = Path(temp_dir)
        registry = temp / "accounts.json"
        run(
            sys.executable,
            "scripts/token_registry.py",
            "init",
            "--registry",
            str(registry),
            "--slots",
            "1",
        )
        mode = stat.S_IMODE(registry.stat().st_mode)
        if mode != 0o600:
            fail(f"registry mode is {oct(mode)}, expected 0o600")
        listed = run(
            sys.executable,
            "scripts/token_registry.py",
            "list",
            "--registry",
            str(registry),
        )
        if "api_token" in listed or "Bearer" in listed:
            fail("registry list printed credential fields")


def main() -> int:
    parse_frontmatter(require_file("SKILL.md"))
    parse_openai_yaml(require_file("agents/openai.yaml"))
    for relative in (
        "README.md",
        "LICENSE",
        "CHANGELOG.md",
        ".gitignore",
        ".env.example",
        "scripts/acquire_subtitle.py",
        "scripts/render_transcript.py",
        "scripts/normalize_subtitle.py",
        "scripts/token_registry.py",
    ):
        require_file(relative)

    check_no_secrets()
    compile_env = dict(os.environ)
    compile_env.setdefault("PYTHONPYCACHEPREFIX", "/tmp/media-content-distiller-pycache")
    run(
        sys.executable,
        "-m",
        "py_compile",
        *[str(path.relative_to(ROOT)) for path in SCRIPTS.glob("*.py")],
        env=compile_env,
    )
    for script in ("acquire_subtitle.py", "render_transcript.py", "normalize_subtitle.py", "token_registry.py"):
        run(sys.executable, f"scripts/{script}", "--help")

    clean_env = dict(os.environ)
    for key in tuple(clean_env):
        if key.startswith("BIBI") or key.startswith("BIBIGPT"):
            clean_env.pop(key)
    with tempfile.TemporaryDirectory() as temp_dir:
        isolated_env = Path(temp_dir) / ".env"
        proc = subprocess.run(
            [
                sys.executable,
                "scripts/acquire_subtitle.py",
                "subtitle",
                "--input",
                "https://example.invalid/video",
                "--output-dir",
                str(Path(temp_dir) / "artifacts"),
                "--env-file",
                str(isolated_env),
            ],
            cwd=ROOT,
            text=True,
            capture_output=True,
            env=clean_env,
        )
        if proc.returncode == 0:
            fail("missing-credential branch unexpectedly succeeded")
        combined = proc.stdout + proc.stderr
        if "未找到可用的 BibiGPT API Token" not in combined or "未发起网络请求" not in combined:
            fail("missing-credential branch did not report a no-network failure")

    test_local_subtitles()
    test_redaction()
    test_registry_permissions()
    print("VERIFY_OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
