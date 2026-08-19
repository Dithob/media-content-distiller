#!/usr/bin/env python3
"""Offline repository checks for the media-content-distiller skill."""

from __future__ import annotations

import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def fail(message: str) -> None:
    raise SystemExit(f"VERIFY_FAIL: {message}")


def require_file(relative: str) -> Path:
    path = ROOT / relative
    if not path.is_file():
        fail(f"missing file: {relative}")
    return path


def parse_frontmatter(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    match = re.match(r"^---\n(.*?)\n---\n", text, re.DOTALL)
    if not match:
        fail("SKILL.md does not have YAML frontmatter")
    values = {}
    for line in match.group(1).splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        key, separator, raw = line.partition(":")
        if not separator:
            fail(f"invalid frontmatter line: {line}")
        values[key.strip()] = raw.strip().strip("\"'")
    if not values.get("name") or not values.get("description"):
        fail("SKILL.md frontmatter needs name and description")
    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", values["name"]):
        fail("skill name is not hyphen-case")
    if len(values["name"]) > 64 or len(values["description"]) > 1024:
        fail("skill frontmatter is too long")


def parse_openai_yaml(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    if not text.startswith("interface:\n"):
        fail("agents/openai.yaml must start with interface:")
    for key in ("display_name:", "short_description:", "default_prompt:"):
        if key not in text:
            fail(f"agents/openai.yaml missing {key}")
    if "$media-content-distiller" not in text:
        fail("default_prompt must mention $media-content-distiller")


def check_no_secrets() -> None:
    pattern = re.compile(
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
        if pattern.search(text):
            fail(f"possible secret in {path.relative_to(ROOT)}")


def run(*args: str, expect: int = 0, env: dict[str, str] | None = None) -> str:
    proc = subprocess.run(args, cwd=ROOT, text=True, capture_output=True, env=env)
    if proc.returncode != expect:
        fail(f"command failed ({proc.returncode} != {expect}): {' '.join(args)}\n{proc.stdout}{proc.stderr}")
    return proc.stdout


def test_offline_cli() -> None:
    fixture = {
        "detail": {
            "title": "离线字幕验证",
            "url": "https://example.invalid/video",
            "duration": 12,
            "subtitlesArray": [
                {"startTime": 0, "endTime": 1.5, "text": "第一句"},
                {"startTime": 2, "endTime": 3.5, "text": "第二句"},
            ],
        }
    }
    with tempfile.TemporaryDirectory() as temp_dir:
        temp = Path(temp_dir)
        raw = temp / "raw.json"
        out = temp / "artifacts"
        raw.write_text(json.dumps(fixture, ensure_ascii=False), encoding="utf-8")
        rows = json.loads(run("node", "bin/media-content-distiller.mjs", "normalize", "--input", str(raw)))
        if len(rows) != 2 or rows[1]["start"] != 2:
            fail("subtitle normalization failed")
        run(
            "node",
            "bin/media-content-distiller.mjs",
            "render",
            "--subtitle",
            str(raw),
            "--out-dir",
            str(out),
            "--sentences-per-group",
            "2",
        )
        transcript = (out / "transcript.md").read_text(encoding="utf-8")
        if "第一句\n第二句" not in transcript or "〔句间分隔〕" in transcript:
            fail("transcript formatting failed")


def test_registry_permissions() -> None:
    with tempfile.TemporaryDirectory() as temp_dir:
        registry = Path(temp_dir) / "accounts.json"
        run("node", "bin/media-content-distiller.mjs", "init", "--registry", str(registry), "--slots", "1")
        if stat.S_IMODE(registry.stat().st_mode) != 0o600:
            fail("registry is not private")
        listed = run("node", "bin/media-content-distiller.mjs", "list", "--registry", str(registry))
        if "api_token" in listed or "Bearer" in listed:
            fail("registry list leaked credential fields")


def main() -> int:
    parse_frontmatter(require_file("SKILL.md"))
    parse_openai_yaml(require_file("agents/openai.yaml"))
    for relative in (
        "README.md",
        "README.en.md",
        "LICENSE",
        ".gitignore",
        ".env.example",
        "package.json",
        "bin/media-content-distiller",
        "bin/media-content-distiller.mjs",
        "lib/core.mjs",
        "lib/cli.mjs",
        "scripts/verify_cli.mjs",
        "tests/cli.test.mjs",
        "references/acquisition.md",
        "references/token-registry.md",
        "references/output.md",
    ):
        require_file(relative)
    check_no_secrets()
    node = shutil.which("node")
    if not node:
        fail("Node.js >= 18 is required")
    for relative in (
        "bin/media-content-distiller.mjs",
        "lib/core.mjs",
        "lib/cli.mjs",
        "scripts/verify_cli.mjs",
        "tests/cli.test.mjs",
    ):
        run(node, "--check", relative)
    source_text = "\n".join((ROOT / "lib" / name).read_text(encoding="utf-8") for name in ("core.mjs", "cli.mjs"))
    if re.search(r"bibi\s+summarize|spawn(?:Sync)?\(\s*[\"']bibi|BibiCli", source_text, re.I):
        fail("Node CLI contains an external bibi adapter")
    skill_text = (ROOT / "SKILL.md").read_text(encoding="utf-8")
    if "curl" not in skill_text or "直接" not in skill_text:
        fail("SKILL.md must document the direct curl path for one-off URL tasks")
    if "probe" not in skill_text or "所有已配置 Token" not in skill_text:
        fail("SKILL.md must document full-registry Token probing")
    if (
        "source sidecars" not in skill_text
        and "来源副产物目录" not in skill_text
        and "source sidecar" not in skill_text
    ):
        fail("SKILL.md must separate sidecars from main documents")
    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    if package.get("bin", {}).get("media-content-distiller") != "./bin/media-content-distiller.mjs":
        fail("package.json must expose the portable .mjs CLI entry point")
    clean_env = {key: value for key, value in os.environ.items() if not key.startswith(("BIBI", "BIBIGPT"))}
    with tempfile.TemporaryDirectory() as temp_dir:
        proc = subprocess.run(
            [node, "--", "bin/media-content-distiller.mjs", "subtitle", "--url", "https://example.invalid/video", "--env-file", str(Path(temp_dir) / ".env"), "--no-prompt"],
            cwd=ROOT, text=True, capture_output=True, env=clean_env,
        )
        if proc.returncode == 0 or "no network request was made" not in proc.stderr:
            fail("missing credential branch failed its safety check")
    test_offline_cli()
    test_registry_permissions()
    print("VERIFY_OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
