import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  compactRows,
  extractPlan,
  newRegistry,
  normalizeSubtitles,
  safeJson,
  saveRegistry,
  selectRegistryAccount,
  suggestDocumentNames,
  validateSubtitles,
} from "../lib/core.mjs";
import { runCli } from "../lib/cli.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BIN = path.join(ROOT, "bin", "media-content-distiller");

function tempDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "media-content-distiller-cli-"));
}

async function captureCli(args) {
  const output = { stdout: "", stderr: "" };
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  process.stdout.write = (chunk, ...rest) => {
    output.stdout += Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
    const callback = rest.find((item) => typeof item === "function");
    if (callback) callback();
    return true;
  };
  process.stderr.write = (chunk, ...rest) => {
    output.stderr += Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
    const callback = rest.find((item) => typeof item === "function");
    if (callback) callback();
    return true;
  };
  try {
    output.code = await runCli(args);
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
  return output;
}

function mockApi() {
  const requests = [];
  const previousFetch = globalThis.fetch;
  let subtitleIndex = 0;
  globalThis.fetch = async (url, options) => {
    const parsed = new URL(url);
    requests.push({
      path: parsed.pathname,
      query: Object.fromEntries(parsed.searchParams.entries()),
      authorization: options.headers.Authorization,
      clientType: options.headers["x-client-type"],
      userAgent: options.headers["User-Agent"],
    });
    if (parsed.pathname === "/v1/me") {
      return new Response(JSON.stringify({ plan: "test", remainingMinutes: 42 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (parsed.pathname === "/v1/getSubtitle") {
      subtitleIndex += 1;
      const input = parsed.searchParams.get("url");
      return new Response(
        JSON.stringify({
          success: true,
          service: "fixture",
          detail: {
            title: `Mock media${subtitleIndex > 1 ? ` ${subtitleIndex}` : ""}`,
            url: input,
            duration: 6,
            subtitlesArray: [
              { startTime: 0, endTime: 1, text: "hello" },
              { startTime: 2, endTime: 3, text: "world" },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
  };
  return {
    requests,
    restore() {
      globalThis.fetch = previousFetch;
    },
  };
}

test("normalizes supported subtitle shapes and keeps cue boundaries", () => {
  const rows = normalizeSubtitles({
    detail: {
      subtitlesArray: [
        { startTime: 0, endTime: 1, text: "第一句" },
        { startTime: 2, endTime: 3, text: "第二句" },
      ],
    },
  });
  assert.equal(rows.length, 2);
  assert.equal(compactRows(rows, 2)[0].text, "第一句\n第二句");
  validateSubtitles(rows);
});

test("extracts plan from nested account responses", () => {
  assert.equal(
    extractPlan({ data: { result: { tier: "pro", remainingMinutes: 9 } } }),
    "pro",
  );
});

test("redacts credential-shaped values", () => {
  const text = JSON.stringify(
    safeJson({
      api_token: "secret-value",
      Authorization: "Bearer secret-value",
      url: "https://example.invalid/?token=secret-value",
    }),
  );
  assert.doesNotMatch(text, /secret-value/);
  assert.match(text, /\[REDACTED\]/);
});

test("registry is private and CLI list never prints a Token", async () => {
  const directory = tempDirectory();
  try {
    const registryPath = path.join(directory, "accounts.json");
    const registry = newRegistry(1);
    registry.accounts[0].api_token = "secret-value";
    registry.accounts[0].remaining_minutes = null;
    saveRegistry(registryPath, registry);
    assert.equal(fs.statSync(registryPath).mode & 0o777, 0o600);

    const result = await captureCli(["list", "--registry", registryPath]);
    assert.equal(result.code, 0);
    assert.doesNotMatch(result.stdout, /secret-value|api_token/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("cached probe failures are not selected for runtime", () => {
  const registry = newRegistry(3);
  registry.accounts[0].api_token = "unknown-token";
  registry.accounts[0].probe_status = "unknown";
  registry.accounts[1].api_token = "rate-limited-token";
  registry.accounts[1].probe_status = "rate_limited";
  registry.accounts[2].api_token = "usable-token";
  registry.accounts[2].probe_status = "usable";
  assert.equal(selectRegistryAccount(registry).token, "unknown-token");
  registry.accounts[0].probe_status = "unavailable";
  assert.equal(selectRegistryAccount(registry).token, "usable-token");
});

test("suggests purpose-aware main document names", () => {
  assert.equal(
    suggestDocumentNames({ title: "Figma 入门" }, { purpose: "整理为操作手册" }).recommended,
    "Figma-入门操作手册.md",
  );
  assert.equal(
    suggestDocumentNames({ title: "Figma 入门" }, { purpose: "总结笔记" }).recommended,
    "Figma-入门摘要.md",
  );
});

test("Node CLI init, setup, bind, and list keep registry credentials private", async () => {
  const directory = tempDirectory();
  try {
    const registryPath = path.join(directory, "accounts.json");
    const envPath = path.join(directory, ".env");
    const token = "fixture-setup-token";
    const init = await captureCli([
      "init",
      "--registry",
      registryPath,
      "--slots",
      "1",
    ]);
    assert.equal(init.code, 0);
    assert.equal(fs.statSync(registryPath).mode & 0o777, 0o600);

    const setup = spawnSync(
      BIN,
      ["setup", "--registry", registryPath, "--env-file", envPath,
        "--token-stdin", "--acknowledge-plaintext-token-storage", "--skip-probe"],
      { input: token, encoding: "utf8" },
    );
    assert.equal(setup.status, 0, setup.stderr);
    assert.doesNotMatch(setup.stdout, new RegExp(token));
    assert.doesNotMatch(setup.stderr, new RegExp(token));
    assert.equal(fs.statSync(registryPath).mode & 0o777, 0o600);
    assert.match(fs.readFileSync(envPath, "utf8"), /BIBIGPT_TOKEN_REGISTRY=/);

    const bind = await captureCli([
      "bind",
      "--registry",
      registryPath,
      "--env-file",
      envPath,
    ]);
    assert.equal(bind.code, 0);
    const list = await captureCli(["list", "--registry", registryPath]);
    assert.equal(list.code, 0);
    assert.doesNotMatch(list.stdout, new RegExp(token));
    assert.doesNotMatch(list.stdout, /api_token/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("probe checks every configured Token and persists status/quota without leaking Tokens", async () => {
  const directory = tempDirectory();
  const previousFetch = globalThis.fetch;
  const registryPath = path.join(directory, "accounts.json");
  const envPath = path.join(directory, ".env");
  const registry = newRegistry(3);
  registry.accounts[0].api_token = "valid-token";
  registry.accounts[1].api_token = "empty-quota-token";
  registry.accounts[2].api_token = "invalid-token";
  saveRegistry(registryPath, registry);
  const requests = [];
  globalThis.fetch = async (url, options) => {
    const token = options.headers.Authorization.replace(/^Bearer /, "");
    requests.push(token);
    if (token === "valid-token") {
      return new Response(JSON.stringify({ data: { plan: "pro", remainingMinutes: 12 } }), { status: 200 });
    }
    if (token === "empty-quota-token") {
      return new Response(JSON.stringify({ data: { plan: "free", remainingMinutes: 0 } }), { status: 200 });
    }
    return new Response(JSON.stringify({ message: "invalid" }), { status: 401 });
  };
  try {
    const result = await captureCli([
      "probe",
      "--registry",
      registryPath,
      "--base-url",
      "https://api.example.invalid",
      "--retries",
      "0",
    ]);
    assert.equal(result.code, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.checked, 3);
    assert.equal(parsed.usableCount, 1);
    assert.deepEqual(requests, ["valid-token", "empty-quota-token", "invalid-token"]);
    assert.doesNotMatch(result.stdout, /valid-token|empty-quota-token|invalid-token/);
    const saved = JSON.parse(fs.readFileSync(registryPath, "utf8"));
    assert.equal(saved.accounts[0].probe_status, "usable");
    assert.equal(saved.accounts[0].remaining_minutes, 12);
    assert.equal(saved.accounts[1].probe_status, "quota_exhausted");
    assert.equal(saved.accounts[2].probe_status, "invalid");
  } finally {
    globalThis.fetch = previousFetch;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("setup and import probe the entire registry, not only newly supplied Tokens", async () => {
  const directory = tempDirectory();
  const previousFetch = globalThis.fetch;
  const registryPath = path.join(directory, "accounts.json");
  const envPath = path.join(directory, ".env");
  const tokensPath = path.join(directory, "tokens.txt");
  const registry = newRegistry(2);
  registry.accounts[0].api_token = "existing-token";
  saveRegistry(registryPath, registry);
  fs.writeFileSync(tokensPath, "new-token\n", "utf8");
  const requested = [];
  globalThis.fetch = async (_url, options) => {
    const token = options.headers.Authorization.replace(/^Bearer /, "");
    requested.push(token);
    return new Response(
      JSON.stringify({ plan: token === "existing-token" ? "legacy" : "pro", remainingMinutes: 8 }),
      { status: 200 },
    );
  };
  try {
    const result = await captureCli([
      "import",
      "--registry",
      registryPath,
      "--env-file",
      envPath,
      "--input",
      tokensPath,
      "--acknowledge-plaintext-token-storage",
      "--base-url",
      "https://api.example.invalid",
      "--retries",
      "0",
    ]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(requested, ["existing-token", "new-token"]);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.probes.length, 2);
    assert.equal(parsed.usableCount, 2);
  } finally {
    globalThis.fetch = previousFetch;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("render command uses metadata from nested response shapes", async () => {
  const directory = tempDirectory();
  try {
    const rawPath = path.join(directory, "raw.json");
    const outputDirectory = path.join(directory, "out");
    fs.writeFileSync(
      rawPath,
      JSON.stringify({
        detail: {
          title: "离线验证",
          url: "https://example.invalid/video",
          duration: 12,
          subtitlesArray: [
            { startTime: 0, endTime: 1.5, text: "第一句" },
            { startTime: 2, endTime: 3.5, text: "第二句" },
          ],
        },
      }),
    );

    const result = await captureCli([
      "render",
      "--subtitle",
      rawPath,
      "--out-dir",
      outputDirectory,
      "--sentences-per-group",
      "2",
    ]);
  assert.equal(result.code, 0);
  const transcript = fs.readFileSync(path.join(outputDirectory, "transcript.md"), "utf8");
  assert.match(transcript, /^# 离线验证｜时间轴转录/m);
  assert.match(transcript, /第一句\n第二句/);
  assert.match(transcript, /覆盖判断：/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("missing credentials fail before any network request", async () => {
  const directory = tempDirectory();
  const previousToken = process.env.BIBI_API_TOKEN;
  const previousFetch = globalThis.fetch;
  let fetchCalls = 0;
  delete process.env.BIBI_API_TOKEN;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("network must not be reached");
  };
  try {
    const result = await captureCli([
      "subtitle",
      "--url",
      "https://example.invalid/video",
      "--env-file",
      path.join(directory, ".env"),
      "--no-prompt",
    ]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /No usable BibiGPT API Token found/);
    assert.match(result.stderr, /no network request was made/);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.BIBI_API_TOKEN;
    else process.env.BIBI_API_TOKEN = previousToken;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("local media fails safely without calling the API", async () => {
  const directory = tempDirectory();
  const mediaPath = path.join(directory, "sample.mp4");
  fs.writeFileSync(mediaPath, "fixture", "utf8");
  const previousToken = process.env.BIBI_API_TOKEN;
  const previousFetch = globalThis.fetch;
  let fetchCalls = 0;
  delete process.env.BIBI_API_TOKEN;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("local media must not call the API");
  };
  try {
    const result = await captureCli([
      "subtitle",
      "--input",
      mediaPath,
      "--output-dir",
      path.join(directory, "media-artifacts"),
      "--no-prompt",
    ]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /accepts public URLs only/);
    assert.match(result.stderr, /not uploaded/);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.BIBI_API_TOKEN;
    else process.env.BIBI_API_TOKEN = previousToken;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("URL subtitle path uses the skill-owned API client and writes artifacts", async () => {
  const directory = tempDirectory();
  const previousToken = process.env.BIBI_API_TOKEN;
  process.env.BIBI_API_TOKEN = "fixture-token";
  const api = mockApi();
  try {
    const result = await captureCli([
      "subtitle",
      "--url",
      "https://example.invalid/video",
      "--base-url",
      "https://api.example.invalid",
      "--output-dir",
      path.join(directory, "media-artifacts"),
      "--no-prompt",
    ]);
    assert.equal(result.code, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.cueCount, 2);
    assert.equal(parsed.response.transport, "api");
    assert.equal(parsed.response.subtitleSource, "BibiGPT official /v1/getSubtitle");
    assert.equal(parsed.suggestedMainFiles.recommended, "Mock-media摘要.md");
    assert.equal(fs.existsSync(parsed.artifacts.rawSubtitle), true);
    assert.equal(fs.existsSync(parsed.transcript), true);
    const raw = fs.readFileSync(parsed.artifacts.rawSubtitle, "utf8");
    assert.doesNotMatch(raw, /fixture-token/);
    assert.deepEqual(
      api.requests.map((item) => item.path),
      ["/v1/me", "/v1/getSubtitle"],
    );
    assert.ok(api.requests.every((item) => item.authorization === "Bearer fixture-token"));
    assert.ok(api.requests.every((item) => item.clientType === "media-content-distiller"));
    assert.ok(api.requests.every((item) => item.userAgent.startsWith("media-content-distiller-cli/")));
    assert.match(fs.readFileSync(parsed.artifacts.folderReadme, "utf8"), /不要塞进主稿正文/);
  } finally {
    api.restore();
    if (previousToken === undefined) delete process.env.BIBI_API_TOKEN;
    else process.env.BIBI_API_TOKEN = previousToken;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("subtitle path never calls BibiGPT summary endpoints", async () => {
  const directory = tempDirectory();
  const previousToken = process.env.BIBI_API_TOKEN;
  process.env.BIBI_API_TOKEN = "fixture-token";
    const api = mockApi();
  try {
    const result = await captureCli([
      "subtitle",
      "--url",
      "https://example.invalid/video",
      "--base-url",
      "https://api.example.invalid",
      "--output-dir",
      path.join(directory, "media-artifacts"),
      "--no-prompt",
    ]);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(api.requests.every((item) => !/summarize|summary/i.test(item.path)));
  } finally {
    api.restore();
    if (previousToken === undefined) delete process.env.BIBI_API_TOKEN;
    else process.env.BIBI_API_TOKEN = previousToken;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("check reports only skill-owned API credential sources", async () => {
  const directory = tempDirectory();
  const previousToken = process.env.BIBI_API_TOKEN;
  process.env.BIBI_API_TOKEN = "fixture-token";
  try {
    const result = await captureCli(["check", "--env-file", path.join(directory, ".env")]);
    assert.equal(result.code, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.provider, "bibigpt");
    assert.equal(parsed.transport, "api");
    assert.equal(parsed.mode, "api");
    assert.equal(parsed.mode, "api");
  } finally {
    if (previousToken === undefined) delete process.env.BIBI_API_TOKEN;
    else process.env.BIBI_API_TOKEN = previousToken;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("batch preflights once, processes public URLs, and writes a manifest", async () => {
  const directory = tempDirectory();
  const inputPath = path.join(directory, "videos.jsonl");
  const outputDirectory = path.join(directory, "media-artifacts");
  fs.writeFileSync(
    inputPath,
    [
      JSON.stringify("https://example.invalid/one"),
      JSON.stringify({ input: "https://example.invalid/two" }),
      JSON.stringify("https://example.invalid/one"),
    ].join("\n"),
  );
  const previousToken = process.env.BIBI_API_TOKEN;
  process.env.BIBI_API_TOKEN = "fixture-token";
  const api = mockApi();
  try {
    const result = await captureCli([
      "batch",
      "--input",
      inputPath,
      "--base-url",
      "https://api.example.invalid",
      "--output-dir",
      outputDirectory,
      "--no-prompt",
    ]);
    assert.equal(result.code, 0, result.stderr);
    const lines = result.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
    const complete = lines.at(-1);
    assert.equal(complete.event, "batch_complete");
    assert.equal(complete.uniqueCount, 2);
    assert.equal(complete.processed, 2);
    assert.equal(complete.failed, 0);
    assert.equal(api.requests.filter((item) => item.path === "/v1/me").length, 1);
    assert.equal(api.requests.filter((item) => item.path === "/v1/getSubtitle").length, 2);
    assert.equal(fs.existsSync(path.join(outputDirectory, "batch-manifest.json")), true);
  } finally {
    api.restore();
    if (previousToken === undefined) delete process.env.BIBI_API_TOKEN;
    else process.env.BIBI_API_TOKEN = previousToken;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("batch rejects local media before any API request", async () => {
  const directory = tempDirectory();
  const inputPath = path.join(directory, "videos.jsonl");
  fs.writeFileSync(inputPath, `${JSON.stringify(path.join(directory, "sample.mp4"))}\n`);
  const previousToken = process.env.BIBI_API_TOKEN;
  const previousFetch = globalThis.fetch;
  let fetchCalls = 0;
  delete process.env.BIBI_API_TOKEN;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("batch local media must not call the API");
  };
  try {
    const result = await captureCli([
      "batch",
      "--input",
      inputPath,
      "--output-dir",
      path.join(directory, "media-artifacts"),
      "--no-prompt",
    ]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /public URLs only/);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.BIBI_API_TOKEN;
    else process.env.BIBI_API_TOKEN = previousToken;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("normalize command validates local subtitle timelines", async () => {
  const directory = tempDirectory();
  try {
    const subtitlePath = path.join(directory, "invalid.json");
    fs.writeFileSync(
      subtitlePath,
      JSON.stringify({
        detail: {
          subtitlesArray: [
            { startTime: 2, endTime: 3, text: "later" },
            { startTime: 1, endTime: 2, text: "earlier" },
          ],
        },
      }),
    );
    const result = await captureCli(["normalize", "--input", subtitlePath]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /Subtitle timeline regressed/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
