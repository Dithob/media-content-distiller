#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BIN = path.join(ROOT, "bin", "media-content-distiller");
const requiredFiles = [
  "package.json",
  "bin/media-content-distiller",
  "bin/media-content-distiller.mjs",
  "lib/core.mjs",
  "lib/cli.mjs",
  "tests/cli.test.mjs",
];

for (const relative of requiredFiles) {
  assert.equal(fs.existsSync(path.join(ROOT, relative)), true, `missing ${relative}`);
}

for (const file of ["bin/media-content-distiller.mjs", "lib/core.mjs", "lib/cli.mjs"]) {
  const result = spawnSync(process.execPath, ["--check", path.join(ROOT, file)], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${file} failed syntax check:\n${result.stderr}`);
}

const help = spawnSync(BIN, ["--help"], { encoding: "utf8" });
assert.equal(help.status, 0);
assert.match(help.stdout, /No Python or third-party npm package is required/);

const version = spawnSync(BIN, ["--version"], { encoding: "utf8" });
assert.equal(version.status, 0);
assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+$/);

const packageJson = JSON.parse(
  fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
);
assert.equal(packageJson.bin?.["media-content-distiller"], "./bin/media-content-distiller.mjs");

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "media-content-distiller-verify-"));
try {
  const isolatedEnv = path.join(temporary, ".env");
  const noCredential = spawnSync(
    BIN,
    [
      "subtitle",
      "--url",
      "https://example.invalid/video",
      "--env-file",
      isolatedEnv,
      "--no-prompt",
    ],
    {
      encoding: "utf8",
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => !key.startsWith("BIBI") && !key.startsWith("BIBIGPT"),
        ),
      ),
    },
  );
  assert.equal(noCredential.status, 2);
  assert.match(noCredential.stderr, /no network request was made/);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

console.log("CLI_VERIFY_OK");
