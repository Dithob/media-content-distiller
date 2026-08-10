import importlib.util
import json
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


RENDER = load_module("render_transcript_test", SCRIPTS / "render_transcript.py")
ACQUIRE = load_module("acquire_subtitle_test", SCRIPTS / "acquire_subtitle.py")
REGISTRY = load_module("token_registry_test", SCRIPTS / "token_registry.py")


class RenderTranscriptTests(unittest.TestCase):
    def setUp(self):
        self.rows = [
            {"index": 0, "start": 0.0, "end": 1.0, "text": "第一句"},
            {"index": 1, "start": 1.5, "end": 2.0, "text": "第二句"},
            {"index": 2, "start": 3.0, "end": 4.0, "text": "第三句"},
        ]

    def test_normalize_supported_shapes(self):
        self.assertEqual(
            RENDER.normalize_subtitles(
                {"detail": {"subtitlesArray": [{"startTime": 0, "endTime": 1, "text": "a"}]}}
            )[0]["text"],
            "a",
        )
        self.assertEqual(
            RENDER.normalize_subtitles(
                {"body": [{"from": 0, "to": 1, "content": "b"}]}
            )[0]["text"],
            "b",
        )

    def test_time_axis_rejects_regression(self):
        bad = [
            {"index": 0, "start": 2.0, "end": 3.0, "text": "a"},
            {"index": 1, "start": 1.0, "end": 2.0, "text": "b"},
        ]
        with self.assertRaises(SystemExit):
            RENDER.validate_subtitles(bad)

    def test_grouped_transcript_default_is_linebreak(self):
        groups = RENDER.compact_rows(self.rows, sentences_per_group=2)
        self.assertEqual(groups[0]["text"], "第一句\n第二句")
        self.assertNotIn("〔句间分隔〕", groups[0]["text"])

    def test_custom_separator(self):
        groups = RENDER.compact_rows(self.rows, sentences_per_group=2, sentence_separator="|")
        self.assertEqual(groups[0]["text"], "第一句 | 第二句")


class AcquisitionTests(unittest.TestCase):
    def test_slug_and_source_id(self):
        self.assertEqual(ACQUIRE.source_id("https://www.bilibili.com/video/BV1abc"), "BV1abc")
        self.assertTrue(ACQUIRE.source_id("https://example.invalid/a/very-long-path"))
        self.assertEqual(ACQUIRE.output_title_slug("https://example.invalid/x", "标题"), "标题")

    def test_safe_json_redacts_credentials(self):
        value = ACQUIRE.safe_json(
            {
                "api_token": "secret-value",
                "Authorization": "Bearer secret-value",
                "url": "https://example.invalid/?token=secret-value",
            }
        )
        text = json.dumps(value, ensure_ascii=False)
        self.assertNotIn("secret-value", text)
        self.assertIn("[REDACTED]", text)


class RegistryTests(unittest.TestCase):
    def test_new_registry_and_private_save(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "accounts.json"
            REGISTRY.save_registry(path, REGISTRY.new_registry(2))
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            data = REGISTRY.load_registry(path)
            self.assertEqual(len(data["accounts"]), 2)

    def test_list_cli_does_not_print_token(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "accounts.json"
            value = REGISTRY.new_registry(1)
            value["accounts"][0]["api_token"] = "secret-value"
            value["accounts"][0]["remaining_minutes"] = None
            REGISTRY.save_registry(path, value)
            proc = subprocess.run(
                [sys.executable, str(SCRIPTS / "token_registry.py"), "list", "--registry", str(path)],
                text=True,
                capture_output=True,
                check=True,
            )
            self.assertNotIn("secret-value", proc.stdout)
            self.assertNotIn("api_token", proc.stdout)


if __name__ == "__main__":
    unittest.main()
