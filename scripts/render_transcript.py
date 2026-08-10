#!/usr/bin/env python3
"""Normalize local subtitle artifacts and render a readable timestamp transcript.

This helper intentionally does not summarize content. BibiGPT supplies the
subtitle source; Codex performs quick/detailed/learning synthesis afterwards.
"""

from __future__ import annotations

import argparse
import json
import math
import re
from pathlib import Path
from typing import Any, Callable

# Keep the default transcript human-readable.  "linebreak" is a stable CLI
# token; it renders as one cue per line and never leaks a placeholder marker
# into the transcript.
DEFAULT_SENTENCE_SEPARATOR = "linebreak"


def load_json(path: Path | None) -> Any:
    if path is None:
        return None
    with path.open("r", encoding="utf-8-sig") as handle:
        return json.load(handle)


def unwrap_json(value: Any) -> Any:
    current = value
    while True:
        changed = False
        if isinstance(current, dict) and "result" in current:
            current = current["result"]
            changed = True
        if isinstance(current, dict) and "data" in current:
            current = current["data"]
            changed = True
        if isinstance(current, dict) and "json" in current:
            current = current["json"]
            changed = True
        if not changed:
            return current


def find_payload(value: Any, predicate: Callable[[Any], bool]) -> Any:
    if predicate(value):
        return value
    if isinstance(value, list):
        for item in value:
            found = find_payload(item, predicate)
            if found is not None:
                return found
    elif isinstance(value, dict):
        for item in value.values():
            found = find_payload(item, predicate)
            if found is not None:
                return found
    return None


def as_float(value: Any, fallback: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return fallback


def normalize_subtitles(raw: Any) -> list[dict[str, Any]]:
    """Normalize BibiGPT and common Bilibili subtitle shapes into cue rows."""
    value = unwrap_json(raw)

    body = find_payload(
        value,
        lambda item: isinstance(item, dict) and isinstance(item.get("body"), list),
    )
    if isinstance(body, dict):
        rows = []
        for index, item in enumerate(body["body"]):
            if not isinstance(item, dict):
                continue
            text = str(item.get("content", item.get("text", ""))).strip()
            if not text:
                continue
            rows.append(
                {
                    "index": index,
                    "start": as_float(item.get("from", item.get("startTime", item.get("start", 0)))),
                    "end": as_float(item.get("to", item.get("end", item.get("from", 0)))),
                    "text": text,
                    **({"speaker_id": item["speaker_id"]} if "speaker_id" in item else {}),
                }
            )
        if rows:
            return rows

    for key in ("subtitlesArray", "subtitles"):
        payload = find_payload(
            value,
            lambda item, key=key: isinstance(item, dict) and isinstance(item.get(key), list),
        )
        if not isinstance(payload, dict):
            continue
        rows = []
        for index, item in enumerate(payload[key]):
            if not isinstance(item, dict):
                continue
            text = str(item.get("text", item.get("content", ""))).strip()
            if not text:
                continue
            rows.append(
                {
                    "index": int(item.get("index", index)),
                    "start": as_float(item.get("startTime", item.get("start", item.get("from", 0)))),
                    "end": as_float(item.get("end", item.get("endTime", item.get("to", item.get("startTime", 0))))),
                    "text": text,
                    **({"speaker_id": item["speaker_id"]} if "speaker_id" in item else {}),
                }
            )
        if rows:
            return rows
    return []


def validate_subtitles(rows: list[dict[str, Any]]) -> None:
    previous_start = -math.inf
    for position, row in enumerate(rows):
        start, end = row["start"], row["end"]
        if not math.isfinite(start) or not math.isfinite(end):
            raise SystemExit(f"字幕第 {position + 1} 条时间不是有限数字")
        if start < 0 or end < start:
            raise SystemExit(
                f"字幕第 {position + 1} 条时间轴无效：start={start}, end={end}"
            )
        if start < previous_start:
            raise SystemExit(
                f"字幕时间轴倒退：第 {position + 1} 条 start={start} < 前一条 start={previous_start}"
            )
        previous_start = start


def find_metadata(raw: Any) -> dict[str, Any]:
    if raw is None:
        return {}
    value = unwrap_json(raw)
    payload = find_payload(
        value,
        lambda item: isinstance(item, dict)
        and any(key in item for key in ("title", "url", "sourceUrl", "duration", "author")),
    )
    result = dict(payload) if isinstance(payload, dict) else {}
    if isinstance(value, dict):
        detail = value.get("detail")
        if isinstance(detail, dict):
            merged = dict(value)
            merged.update(detail)
            result = merged
    if not result.get("url"):
        result["url"] = result.get("sourceUrl")
    return result


def fmt_time(seconds: float) -> str:
    total = max(0, int(round(seconds)))
    hours, remainder = divmod(total, 3600)
    minutes, secs = divmod(remainder, 60)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}" if hours else f"{minutes:02d}:{secs:02d}"


def slugify(text: str) -> str:
    text = re.sub(r"[^\w\u4e00-\u9fff-]+", "-", text, flags=re.UNICODE)
    return re.sub(r"-{2,}", "-", text).strip("-_") or "media-content"


def completeness(rows: list[dict[str, Any]], duration: float | None) -> str:
    if not rows:
        return "未获取到可验证字幕"
    first, last = rows[0]["start"], rows[-1]["end"]
    if duration and duration > 0:
        gap = max(0.0, duration - last)
        if first <= 1.0 and gap <= max(5.0, duration * 0.03):
            return "看起来覆盖完整（仍建议抽查尾部）"
        return f"部分覆盖：首条 {fmt_time(first)}，末条 {fmt_time(last)}，距视频时长约 {gap:.1f} 秒"
    return f"已获取 {len(rows)} 条 cue，覆盖 {fmt_time(first)}–{fmt_time(last)}"


def resolve_sentence_separator(separator: str | None) -> str:
    """Resolve friendly separator tokens while retaining literal compatibility."""
    value = DEFAULT_SENTENCE_SEPARATOR if separator is None else str(separator)
    if value in {"linebreak", "newline", r"\n"}:
        return "\n"
    if value == "space":
        return " "
    return value


def describe_sentence_separator(separator: str | None) -> str:
    value = resolve_sentence_separator(separator)
    if value == "\n":
        return "换行"
    if value == " ":
        return "空格"
    if value == "|":
        return "竖线（|）"
    return f"自定义分隔符 `{value}`"


def join_subtitle_text(parts: list[str], separator: str = DEFAULT_SENTENCE_SEPARATOR) -> str:
    """Keep each cue readable without inserting a fake transcript marker."""
    cleaned = [part.strip() for part in parts if part and part.strip()]
    if not cleaned:
        return ""
    value = resolve_sentence_separator(separator)
    if value == "|":
        return " | ".join(cleaned)
    return value.join(cleaned)


def compact_rows(
    rows: list[dict[str, Any]],
    *,
    sentences_per_group: int = 10,
    sentence_separator: str = DEFAULT_SENTENCE_SEPARATOR,
) -> list[dict[str, Any]]:
    if sentences_per_group < 1:
        raise ValueError("sentences_per_group must be at least 1")
    groups: list[dict[str, Any]] = []
    for offset in range(0, len(rows), sentences_per_group):
        chunk = rows[offset : offset + sentences_per_group]
        groups.append(
            {
                "index": len(groups),
                "start": chunk[0]["start"],
                "end": chunk[-1]["end"],
                "startCue": chunk[0]["index"],
                "endCue": chunk[-1]["index"],
                "sentenceCount": len(chunk),
                "text": join_subtitle_text(
                    [row["text"] for row in chunk], sentence_separator
                ),
            }
        )
    return groups


def render_transcript(
    meta: dict[str, Any],
    rows: list[dict[str, Any]],
    *,
    sentences_per_group: int = 10,
    sentence_separator: str = DEFAULT_SENTENCE_SEPARATOR,
    artifact_id: str | None = None,
    output_name: str = "transcript.md",
    legacy_naming: bool = False,
) -> str:
    title = meta.get("title") or "未命名音视频"
    duration = as_float(meta.get("duration", meta.get("durationSec", 0)))
    groups = compact_rows(
        rows,
        sentences_per_group=sentences_per_group,
        sentence_separator=sentence_separator,
    )
    lines = [
        f"# {title}｜时间轴转录",
        "",
        f"> 本文由字幕 JSON 排版生成；每 {sentences_per_group} 条 cue 合并一个时间段，"
        f"组内 cue 之间使用{describe_sentence_separator(sentence_separator)}分隔，未对原文进行静默改写。",
        "> “覆盖完整”仅表示时间轴检查结果，仍建议抽查视频尾部。",
        "",
        "## 视频信息",
        "",
        f"- 原始链接：{meta.get('url', meta.get('sourceUrl', '未提供'))}",
        f"- 平台/服务：{meta.get('service', meta.get('platform', '未提供'))}",
        f"- 作者：{meta.get('author', '未提供')}",
        f"- 时长：{fmt_time(duration)}",
        f"- 字幕来源：{meta.get('subtitleSource', 'BibiGPT getSubtitle / bibi --subtitle')}",
        f"- 获取方式：{meta.get('transport', meta.get('apiMode', '未提供'))}",
        f"- 原始字幕 cue：{len(rows)} 条",
        f"- 合并后时间段：{len(groups)} 段（每段最多 {sentences_per_group} 条）",
        f"- cue 分隔方式：{describe_sentence_separator(sentence_separator)}",
        f"- 首条/末条：{fmt_time(rows[0]['start'])}–{fmt_time(rows[-1]['end'])}",
        f"- 覆盖判断：{completeness(rows, duration)}",
        "",
        "## 时间轴转录",
        "",
    ]
    for group in groups:
        lines.extend(
            [
                f"### {fmt_time(group['start'])}–{fmt_time(group['end'])}",
                group["text"],
                "",
            ]
        )
    return "\n".join(lines).rstrip() + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(description="标准化字幕并生成可读的时间轴转录")
    parser.add_argument("--subtitle", required=True, type=Path, help="原始字幕 JSON")
    parser.add_argument("--metadata", type=Path, help="可选元数据 JSON")
    parser.add_argument("--out-dir", required=True, type=Path)
    parser.add_argument("--slug")
    parser.add_argument("--artifact-id", help="副产物目录使用的短来源 ID")
    parser.add_argument("--output-name", default="transcript.md", help="输出文件名；默认 transcript.md")
    parser.add_argument("--legacy-naming", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--sentences-per-group", type=int, default=10)
    parser.add_argument("--sentence-separator", default=DEFAULT_SENTENCE_SEPARATOR)
    # Compatibility flags: synthesis is intentionally no longer performed here.
    parser.add_argument("--summary", type=Path, help=argparse.SUPPRESS)
    parser.add_argument("--chapters", type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args()

    raw = load_json(args.subtitle)
    rows = normalize_subtitles(raw)
    if not rows:
        raise SystemExit("未找到可识别字幕：需要 subtitlesArray、subtitles[] 或 body[]")
    validate_subtitles(rows)
    meta = find_metadata(load_json(args.metadata)) if args.metadata else find_metadata(raw)
    if args.sentences_per_group < 1:
        raise SystemExit("--sentences-per-group 必须大于等于 1")
    slug = args.slug or slugify(str(meta.get("title") or args.subtitle.stem))
    args.out_dir.mkdir(parents=True, exist_ok=True)
    transcript_name = (
        f"{slug}-transcript.md" if args.legacy_naming else args.output_name
    )
    # In the current artifact layout, the caller passes the explicit short
    # filename `transcript.md`; direct legacy callers may still omit it.
    transcript_path = args.out_dir / transcript_name
    transcript_path.write_text(
        render_transcript(
            meta,
            rows,
            sentences_per_group=args.sentences_per_group,
            sentence_separator=args.sentence_separator,
            artifact_id=args.artifact_id,
            output_name=transcript_name,
            legacy_naming=args.legacy_naming,
        ),
        encoding="utf-8",
    )
    print(
        json.dumps(
            {
                "slug": slug,
                "artifactId": args.artifact_id,
                "cueCount": len(rows),
                "first": rows[0]["start"],
                "last": rows[-1]["end"],
                "sentencesPerGroup": args.sentences_per_group,
                "sentenceSeparator": args.sentence_separator,
                "sentenceSeparatorDescription": describe_sentence_separator(
                    args.sentence_separator
                ),
                "transcriptGroups": len(
                    compact_rows(
                        rows,
                        sentences_per_group=args.sentences_per_group,
                        sentence_separator=args.sentence_separator,
                    )
                ),
                "outputs": [str(transcript_path)],
                "synthesis": "codex-after-subtitle",
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
