#!/usr/bin/env python3
"""Legacy Python wrapper for the skill-owned Token registry CLI."""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "bin" / "media-content-distiller.mjs"


def main() -> None:
    node = shutil.which("node")
    if not node:
        raise SystemExit(
            "Token registry 的 Python 兼容入口需要 Node.js 18+；"
            "请直接使用 media-content-distiller CLI"
        )
    if not CLI.is_file():
        raise SystemExit(f"找不到 skill-owned Node CLI：{CLI}")
    os.execv(node, [node, str(CLI), "--", *sys.argv[1:]])


if __name__ == "__main__":
    main()
