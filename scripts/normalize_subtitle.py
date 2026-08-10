#!/usr/bin/env python3
"""Print normalized subtitle cues from a local BibiGPT/Bilibili JSON artifact."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from render_transcript import normalize_subtitles, validate_subtitles


def main() -> None:
    parser = argparse.ArgumentParser(description="标准化字幕 JSON")
    parser.add_argument("--input", required=True, type=Path)
    args = parser.parse_args()
    with args.input.open("r", encoding="utf-8") as handle:
        rows = normalize_subtitles(json.load(handle))
    if not rows:
        raise SystemExit("未找到可识别字幕")
    validate_subtitles(rows)
    print(json.dumps(rows, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
