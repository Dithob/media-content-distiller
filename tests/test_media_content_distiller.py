import json
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"


class PythonCompatibilityTests(unittest.TestCase):
    def test_python_entrypoints_are_wrappers(self):
        for script in (
            "acquire_subtitle.py",
            "bibigpt_api.py",
            "build_learning_doc.py",
            "normalize_subtitle.py",
            "render_transcript.py",
            "token_registry.py",
        ):
            text = (SCRIPTS / script).read_text(encoding="utf-8")
            self.assertIn("skill-owned", text.lower())

    def test_python_normalize_wrapper_uses_node_cli(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            raw = Path(temp_dir) / "raw.json"
            raw.write_text(
                json.dumps(
                    {
                        "detail": {
                            "subtitlesArray": [
                                {"startTime": 0, "endTime": 1, "text": "hello"}
                            ]
                        }
                    }
                ),
                encoding="utf-8",
            )
            proc = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPTS / "normalize_subtitle.py"),
                    "--input",
                    str(raw),
                ],
                text=True,
                capture_output=True,
                check=True,
            )
            self.assertEqual(json.loads(proc.stdout)[0]["text"], "hello")

    def test_python_registry_wrapper_keeps_token_private(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "accounts.json"
            proc = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPTS / "token_registry.py"),
                    "init",
                    "--registry",
                    str(path),
                    "--slots",
                    "1",
                ],
                text=True,
                capture_output=True,
                check=True,
            )
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertNotIn("api_token", proc.stdout)

    def test_python_render_wrapper_writes_transcript(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            temp = Path(temp_dir)
            raw = temp / "raw.json"
            output = temp / "out"
            raw.write_text(
                json.dumps(
                    {
                        "detail": {
                            "title": "兼容测试",
                            "subtitlesArray": [
                                {"startTime": 0, "endTime": 1, "text": "第一句"},
                                {"startTime": 2, "endTime": 3, "text": "第二句"},
                            ],
                        }
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            subprocess.run(
                [
                    sys.executable,
                    str(SCRIPTS / "render_transcript.py"),
                    "--subtitle",
                    str(raw),
                    "--out-dir",
                    str(output),
                    "--sentences-per-group",
                    "2",
                ],
                text=True,
                capture_output=True,
                check=True,
            )
            transcript = (output / "transcript.md").read_text(encoding="utf-8")
            self.assertIn("第一句\n第二句", transcript)


if __name__ == "__main__":
    unittest.main()
