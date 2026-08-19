#!/usr/bin/env python3
"""Legacy Python wrapper for offline subtitle rendering."""

from __future__ import annotations

import argparse
import os
import shutil
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "bin" / "media-content-distiller.mjs"


def main() -> None:
    parser = argparse.ArgumentParser(description="使用 skill-owned Node CLI 渲染字幕")
    parser.add_argument("--subtitle", required=True, type=Path)
    parser.add_argument("--metadata", type=Path)
    parser.add_argument("--out-dir", required=True, type=Path)
    parser.add_argument("--output-name", default="transcript.md")
    parser.add_argument("--artifact-id", help=argparse.SUPPRESS)
    parser.add_argument("--slug", help=argparse.SUPPRESS)
    parser.add_argument("--legacy-naming", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--sentences-per-group", type=int, default=10)
    parser.add_argument("--sentence-separator", default="linebreak")
    parser.add_argument("--summary", type=Path, help=argparse.SUPPRESS)
    parser.add_argument("--chapters", type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args()

    node = shutil.which("node")
    if not node:
        raise SystemExit(
            "字幕渲染的 Python 兼容入口需要 Node.js 18+；"
            "请直接使用 media-content-distiller render"
        )
    command = [
        node,
        str(CLI),
        "--",
        "render",
        "--subtitle",
        str(args.subtitle),
        "--out-dir",
        str(args.out_dir),
        "--output-name",
        str(args.output_name),
        "--sentences-per-group",
        str(args.sentences_per_group),
        "--sentence-separator",
        str(args.sentence_separator),
    ]
    if args.metadata:
        command.extend(["--metadata", str(args.metadata)])
    os.execv(node, command)


if __name__ == "__main__":
    main()
