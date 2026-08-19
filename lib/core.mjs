import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const ENV_REGISTRY_KEY = "BIBIGPT_TOKEN_REGISTRY";
export const ENV_TOKEN_KEY = "BIBI_API_TOKEN";
export const DEFAULT_ACCOUNTS_FILE = "accounts.json";
export const LEGACY_ACCOUNTS_FILE = "accounts-tokens.json";
export const DEFAULT_BASE_URL = "https://api.bibigpt.co/api";
export const CLI_VERSION = "1.2.0";

export class CliError extends Error {
  constructor(message, { code = 2, detail = null } = {}) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.detail = detail;
  }
}

export class ApiError extends CliError {
  constructor(status, detail, retryAfter = null) {
    const message = status
      ? `BibiGPT API request failed: HTTP ${status}`
      : "BibiGPT API request failed";
    super(message, { detail, code: 2 });
    this.status = status;
    this.retryAfter = retryAfter;
    this.detail = safeJson(detail);
  }
}

export function toCamel(value) {
  return value.replace(/-([a-z])/g, (_, character) => character.toUpperCase());
}

export function parseArgs(argv) {
  const options = { _: [] };
  const booleanOptions = new Set([
    "help",
    "version",
    "force",
    "replace",
    "token-stdin",
    "acknowledge-plaintext-token-storage",
    "no-prompt",
    "refresh",
    "preflight",
    "enabled-speaker",
    "json",
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (raw === "--") {
      options._.push(...argv.slice(index + 1));
      break;
    }
    if (!raw.startsWith("-")) {
      options._.push(raw);
      continue;
    }
    if (raw === "-h") {
      options.help = true;
      continue;
    }
    if (raw === "-v") {
      options.version = true;
      continue;
    }
    const withoutPrefix = raw.replace(/^--?/, "");
    const [rawKey, inlineValue] = withoutPrefix.split("=", 2);
    const key = toCamel(rawKey);
    if (booleanOptions.has(rawKey)) {
      options[key] = inlineValue === undefined ? true : inlineValue !== "false";
      continue;
    }
    if (inlineValue !== undefined) {
      options[key] = inlineValue;
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("-")) {
      throw new CliError(`Option --${rawKey} requires a value`);
    }
    options[key] = next;
    index += 1;
  }
  return options;
}

export function nowIso() {
  return new Date().toISOString();
}

export function ensureDir(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

export function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new CliError(`File not found: ${filePath}`);
    }
    if (error instanceof SyntaxError) {
      throw new CliError(`Invalid JSON: ${filePath}`);
    }
    throw error;
  }
}

export function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function setPrivateMode(filePath) {
  if (process.platform !== "win32") {
    fs.chmodSync(filePath, 0o600);
  }
}

export function requirePrivateFile(filePath) {
  if (!fs.existsSync(filePath) || process.platform === "win32") {
    return;
  }
  const mode = fs.statSync(filePath).mode & 0o777;
  if (mode & 0o077) {
    throw new CliError(
      `Registry permissions are too broad (${mode.toString(8)}): run chmod 600 ${filePath}`,
    );
  }
}

export function resolvePathReference(reference, baseDirectory = process.cwd()) {
  const expanded = String(reference).replace(/^~(?=$|\/)/, os.homedir());
  return path.resolve(path.isAbsolute(expanded) ? expanded : path.join(baseDirectory, expanded));
}

export function discoverDotenv(startDirectory = process.cwd()) {
  let current = path.resolve(startDirectory);
  if (fs.existsSync(current) && fs.statSync(current).isFile()) {
    current = path.dirname(current);
  }
  while (true) {
    const candidate = path.join(current, ".env");
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export function readDotenvValue(filePath, key) {
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }
  const pattern = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;
  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trim().startsWith("#")) {
      continue;
    }
    const match = rawLine.match(pattern);
    if (!match || match[1] !== key) {
      continue;
    }
    let value = match[2].trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      try {
        return JSON.parse(value);
      } catch {
        return value.slice(1, -1);
      }
    }
    if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
      return value.slice(1, -1);
    }
    return value.split(/\s+#/, 1)[0].trim();
  }
  return null;
}

function dotenvValue(value) {
  return /[\s#"']/.test(value) ? JSON.stringify(value) : value;
}

export function writeEnvPointer(envFile, registryFile) {
  const absoluteEnv = path.resolve(envFile);
  const absoluteRegistry = path.resolve(registryFile);
  ensureDir(path.dirname(absoluteEnv));
  const relative = path.relative(path.dirname(absoluteEnv), absoluteRegistry) || ".";
  const reference = relative.startsWith(".") ? relative : `./${relative}`;
  const assignment = `${ENV_REGISTRY_KEY}=${dotenvValue(reference)}`;
  const existing = fs.existsSync(absoluteEnv)
    ? fs.readFileSync(absoluteEnv, "utf8").split(/\r?\n/)
    : [];
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${ENV_REGISTRY_KEY}\\s*=`);
  const output = [];
  let replaced = false;
  for (const line of existing) {
    if (pattern.test(line)) {
      if (!replaced) {
        output.push(assignment);
        replaced = true;
      }
    } else if (line !== "" || output.length > 0) {
      output.push(line);
    }
  }
  if (!replaced) {
    if (output.length && output.at(-1) !== "") {
      output.push("");
    }
    output.push(assignment);
  }
  fs.writeFileSync(absoluteEnv, `${output.join("\n").replace(/\n+$/, "")}\n`, "utf8");
  setPrivateMode(absoluteEnv);
}

export function defaultRegistryPath(envFile = null) {
  return path.resolve(path.dirname(envFile || path.join(process.cwd(), ".env")), DEFAULT_ACCOUNTS_FILE);
}

function emptyAccount(id) {
  return { id, api_token: null, remaining_minutes: 0 };
}

export function newRegistry(slots = 1) {
  if (!Number.isInteger(Number(slots)) || Number(slots) < 0 || Number(slots) > 100) {
    throw new CliError("--slots must be between 0 and 100");
  }
  const accounts = [];
  for (let index = 1; index <= Number(slots); index += 1) {
    accounts.push(emptyAccount(`account-${String(index).padStart(2, "0")}`));
  }
  return {
    schemaVersion: 2,
    simulationOnly: false,
    networkAccess: "api-only",
    provider: "bibigpt",
    note:
      "User-authorized BibiGPT API tokens. Select the first token in registry order with positive remaining_minutes; null means unknown and is checked once with /v1/me. Stop on auth, quota, or rate-limit errors; do not rotate automatically.",
    selection: {
      order: "registry",
      requiresPositiveRemainingMinutes: true,
      unknownBalanceRequiresPreflight: true,
      rotateAfterError: false,
    },
    accounts,
  };
}

export function normalizeRegistry(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.accounts)) {
    throw new CliError("Invalid registry: expected an accounts array");
  }
  const seen = new Set();
  const accounts = value.accounts.map((account) => {
    if (!account || typeof account !== "object" || !account.id) {
      throw new CliError("Invalid registry: each account needs an id");
    }
    const id = String(account.id);
    if (seen.has(id)) {
      throw new CliError(`Duplicate account id in registry: ${id}`);
    }
    seen.add(id);
    const token = account.api_token == null ? null : String(account.api_token).trim() || null;
    if (token && /\s/.test(token)) {
      throw new CliError(`Token must not contain whitespace: ${id}`);
    }
    let remaining = account.remaining_minutes;
    if (remaining == null || remaining === "") {
      remaining = null;
    } else {
      remaining = Number(remaining);
      if (!Number.isFinite(remaining) || remaining < 0) {
        throw new CliError(`Invalid remaining_minutes: ${id}`);
      }
    }
    const normalized = { id, api_token: token, remaining_minutes: remaining };
    if (account.label != null) {
      normalized.label = String(account.label);
    }
    return normalized;
  });
  return { ...value, accounts };
}

export function loadRegistry(filePath) {
  requirePrivateFile(filePath);
  return normalizeRegistry(readJson(filePath));
}

export function saveRegistry(filePath, value) {
  const absolute = path.resolve(filePath);
  ensureDir(path.dirname(absolute));
  const temporary = path.join(
    path.dirname(absolute),
    `.${path.basename(absolute)}.${crypto.randomBytes(4).toString("hex")}.tmp`,
  );
  fs.writeFileSync(temporary, `${JSON.stringify(normalizeRegistry(value), null, 2)}\n`, "utf8");
  setPrivateMode(temporary);
  fs.renameSync(temporary, absolute);
  setPrivateMode(absolute);
}

export function discoverRegistry({ registry, envFile } = {}) {
  const resolvedEnv = envFile
    ? resolvePathReference(envFile)
    : discoverDotenv();
  if (registry) {
    return { registry: resolvePathReference(registry), envFile: resolvedEnv };
  }
  const processPointer = process.env[ENV_REGISTRY_KEY]?.trim();
  if (processPointer) {
    return { registry: resolvePathReference(processPointer), envFile: resolvedEnv };
  }
  const dotenvPointer = resolvedEnv ? readDotenvValue(resolvedEnv, ENV_REGISTRY_KEY) : null;
  if (dotenvPointer) {
    return {
      registry: resolvePathReference(dotenvPointer, path.dirname(resolvedEnv)),
      envFile: resolvedEnv,
    };
  }
  const base = resolvedEnv ? path.dirname(resolvedEnv) : process.cwd();
  for (const filename of [DEFAULT_ACCOUNTS_FILE, LEGACY_ACCOUNTS_FILE]) {
    const candidate = path.join(base, filename);
    if (fs.existsSync(candidate)) {
      return { registry: path.resolve(candidate), envFile: resolvedEnv };
    }
  }
  return { registry: null, envFile: resolvedEnv };
}

function firstEmptyAccount(registry) {
  return registry.accounts.find((account) => !account.api_token);
}

function findAccount(registry, accountId) {
  const account = registry.accounts.find((candidate) => candidate.id === accountId);
  if (!account) {
    throw new CliError(`Account slot not found: ${accountId}`);
  }
  return account;
}

export function selectRegistryAccount(registry, options = {}) {
  if (options.accountId) {
    const account = findAccount(registry, options.accountId);
    if (!account.api_token) {
      throw new CliError(`Account slot has no Token: ${options.accountId}`);
    }
    return { token: account.api_token, accountId: account.id };
  }
  for (const account of registry.accounts) {
    if (!account.api_token) {
      continue;
    }
    if (account.remaining_minutes != null) {
      if (account.remaining_minutes <= 0) {
        continue;
      }
      if (
        options.minimumMinutes != null &&
        account.remaining_minutes < Number(options.minimumMinutes)
      ) {
        continue;
      }
    }
    return { token: account.api_token, accountId: account.id };
  }
  throw new CliError("Registry has no usable Token");
}

function readPipedToken() {
  return fs.readFileSync(0, "utf8").trim();
}

function readHiddenToken(prompt = "BibiGPT API Token (input hidden): ") {
  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== "function") {
    throw new CliError(
      "Hidden Token input requires a TTY; use --token-stdin only when input is supplied through a secure pipe",
    );
  }
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    let value = "";
    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      stdout.write("\n");
    };
    const onData = (chunk) => {
      const text = chunk.toString("utf8");
      for (const character of text) {
        if (character === "\u0003") {
          cleanup();
          reject(new CliError("Token input cancelled"));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          resolve(value);
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
        } else {
          value += character;
        }
      }
    };
    stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

export async function readToken({ tokenStdin = false } = {}) {
  const token = tokenStdin ? readPipedToken() : await readHiddenToken();
  if (!token) {
    throw new CliError("No Token was read");
  }
  if (/\s/.test(token)) {
    throw new CliError("Token must not contain whitespace");
  }
  return token;
}

function requirePlaintextAck(options) {
  if (!options.acknowledgePlaintextTokenStorage) {
    throw new CliError(
      "The Token will be saved in a 0600 project registry; add --acknowledge-plaintext-token-storage to confirm",
    );
  }
}

export async function setupRegistry(options = {}) {
  requirePlaintextAck(options);
  const envFile = resolvePathReference(
    options.envFile || path.join(process.cwd(), ".env"),
  );
  const registryFile = resolvePathReference(
    options.registry || defaultRegistryPath(envFile),
  );
  const registry = fs.existsSync(registryFile)
    ? loadRegistry(registryFile)
    : newRegistry(Number(options.slots || 1));
  let account = options.accountId
    ? findAccount(registry, options.accountId)
    : firstEmptyAccount(registry);
  if (!account) {
    account = emptyAccount(`account-${String(registry.accounts.length + 1).padStart(2, "0")}`);
    registry.accounts.push(account);
  }
  if (account.api_token && !options.replace) {
    throw new CliError(
      `Account slot already has a Token: ${account.id}; use --replace to overwrite`,
    );
  }
  const token = await readToken({ tokenStdin: Boolean(options.tokenStdin) });
  account.api_token = token;
  account.remaining_minutes = null;
  if (options.label != null) {
    account.label = String(options.label);
  }
  saveRegistry(registryFile, registry);
  writeEnvPointer(envFile, registryFile);
  return {
    initialized: true,
    registry: registryFile,
    envFile,
    accountId: account.id,
    tokenStored: true,
    tokenPrinted: false,
  };
}

export async function resolveToken(options = {}) {
  const envFile = options.envFile
    ? resolvePathReference(options.envFile)
    : discoverDotenv();

  if (options.registry) {
    const registryFile = resolvePathReference(options.registry);
    if (!fs.existsSync(registryFile)) {
      throw new CliError(`Registry not found: ${registryFile}; no network request was made`);
    }
    return { ...selectRegistryAccount(loadRegistry(registryFile), options), registryFile, envFile };
  }
  if (options.tokenEnv) {
    const token = process.env[options.tokenEnv]?.trim();
    if (!token) {
      throw new CliError(`Environment variable ${options.tokenEnv} is empty or unset`);
    }
    return { token, accountId: null, registryFile: null, envFile };
  }
  const processToken = process.env[ENV_TOKEN_KEY]?.trim();
  if (processToken) {
    return { token: processToken, accountId: null, registryFile: null, envFile };
  }
  const dotenvToken = envFile ? readDotenvValue(envFile, ENV_TOKEN_KEY)?.trim() : null;
  if (dotenvToken) {
    return { token: dotenvToken, accountId: null, registryFile: null, envFile };
  }

  const discovered = discoverRegistry({ envFile });
  if (discovered.registry && fs.existsSync(discovered.registry)) {
    return {
      ...selectRegistryAccount(loadRegistry(discovered.registry), options),
      registryFile: discovered.registry,
      envFile: discovered.envFile,
    };
  }

  const reason =
    "No usable BibiGPT API Token found (checked BIBI_API_TOKEN, .env, and project accounts.json); no network request was made.";
  if (options.noPrompt || !process.stdin.isTTY || !process.stdout.isTTY) {
    throw new CliError(reason);
  }
  process.stderr.write(`${reason}\n`);
  process.stderr.write(
    "The CLI can initialize a project-local 0600 registry now. Continue? [Y/n] ",
  );
  const answer = await readLineOnce();
  if (answer && !["y", "yes", "是", "确认"].includes(answer.toLowerCase())) {
    throw new CliError("Token setup cancelled; no network request was made.");
  }
  const result = await setupRegistry({
    registry: defaultRegistryPath(envFile),
    envFile: envFile || path.join(process.cwd(), ".env"),
    slots: 1,
    acknowledgePlaintextTokenStorage: true,
  });
  return {
    token: selectRegistryAccount(loadRegistry(result.registry), {}).token,
    accountId: result.accountId,
    registryFile: result.registry,
    envFile: result.envFile,
  };
}

function readLineOnce() {
  return new Promise((resolve) => {
    let value = "";
    const onData = (chunk) => {
      value += chunk.toString("utf8");
      if (value.includes("\n") || value.includes("\r")) {
        process.stdin.removeListener("data", onData);
        process.stdin.pause();
        resolve(value.trim());
      }
    };
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

export function redactString(value) {
  const bearer = value.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]");
  return bearer.replace(
    /([?&](?:api[_-]?key|api[_-]?token|access[_-]?token|authorization|cookie|secret|token)=)[^&#\s]+/gi,
    "$1[REDACTED]",
  );
}

export function safeJson(value) {
  if (Array.isArray(value)) {
    return value.map(safeJson);
  }
  if (value && typeof value === "object") {
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      if (/token|cookie|secret|password|authorization|api[_-]?key/i.test(key)) {
        output[key] = "[REDACTED]";
      } else {
        output[key] = safeJson(item);
      }
    }
    return output;
  }
  return typeof value === "string" ? redactString(value) : value;
}

export function remainingMinutes(response) {
  if (!response || typeof response !== "object") {
    return null;
  }
  for (const key of ["remainingMinutes", "remaining_minutes"]) {
    if (response[key] != null && Number.isFinite(Number(response[key]))) {
      return Number(response[key]);
    }
  }
  for (const key of ["remainingTime", "remaining_time"]) {
    if (response[key] != null && Number.isFinite(Number(response[key]))) {
      return Number(response[key]) / 60;
    }
  }
  return null;
}

function queryString(query = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value == null || value === false || value === "") {
      continue;
    }
    search.set(key, String(value));
  }
  return search.toString();
}

export async function requestJson(baseUrl, requestPath, token, options = {}) {
  const query = queryString(options.query);
  const url = `${String(baseUrl).replace(/\/+$/, "")}/${String(requestPath).replace(/^\/+/, "")}${
    query ? `?${query}` : ""
  }`;
  const retries = Number(options.retries ?? 2);
  const timeout = Number(options.timeout ?? 90) * 1000;
  for (let attempt = 0; ; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, {
        method: options.method || "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          "x-client-type": "media-content-distiller",
          "User-Agent": `media-content-distiller-cli/${CLI_VERSION}`,
        },
        signal: controller.signal,
      });
      const raw = await response.text();
      let data;
      try {
        data = raw ? JSON.parse(raw) : {};
      } catch {
        data = { raw: raw.slice(0, 4000) };
      }
      if (response.status >= 500 && attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(2 ** attempt, 8) * 1000));
        continue;
      }
      if (!response.ok) {
        throw new ApiError(response.status, data, response.headers.get("retry-after"));
      }
      return { status: response.status, data, headers: response.headers };
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(2 ** attempt, 8) * 1000));
        continue;
      }
      throw new ApiError(0, { message: error.name === "AbortError" ? "Request timeout" : error.message });
    } finally {
      clearTimeout(timer);
    }
  }
}

export function unwrapJson(value) {
  let current = value;
  while (current && typeof current === "object" && !Array.isArray(current)) {
    let changed = false;
    for (const key of ["result", "data", "json"]) {
      if (current[key] && typeof current[key] === "object") {
        current = current[key];
        changed = true;
        break;
      }
    }
    if (!changed) {
      break;
    }
  }
  return current;
}

export function findPayload(value, predicate) {
  if (predicate(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findPayload(item, predicate);
      if (found !== undefined) {
        return found;
      }
    }
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      const found = findPayload(item, predicate);
      if (found !== undefined) {
        return found;
      }
    }
  }
  return undefined;
}

function asNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function normalizeSubtitles(raw) {
  const value = unwrapJson(raw);
  const bodyPayload = findPayload(
    value,
    (item) => item && typeof item === "object" && Array.isArray(item.body),
  );
  if (bodyPayload) {
    const rows = bodyPayload.body
      .filter((item) => item && typeof item === "object")
      .map((item, index) => {
        const text = String(item.content ?? item.text ?? "").trim();
        return {
          index,
          start: asNumber(item.from ?? item.startTime ?? item.start),
          end: asNumber(
            item.to ?? item.end ?? item.endTime ?? item.startTime ?? item.start,
          ),
          text,
          ...(item.speaker_id == null ? {} : { speaker_id: item.speaker_id }),
        };
      })
      .filter((row) => row.text);
    if (rows.length) {
      return rows;
    }
  }

  for (const key of ["subtitlesArray", "subtitles"]) {
    const payload = findPayload(
      value,
      (item) => item && typeof item === "object" && Array.isArray(item[key]),
    );
    if (!payload) {
      continue;
    }
    const rows = payload[key]
      .filter((item) => item && typeof item === "object")
      .map((item, index) => {
        const text = String(item.text ?? item.content ?? "").trim();
        const start = item.startTime ?? item.start ?? item.from;
        const end = item.endTime ?? item.end ?? item.to ?? start;
        return {
          index: Number.isFinite(Number(item.index)) ? Number(item.index) : index,
          start: asNumber(start),
          end: asNumber(end),
          text,
          ...(item.speaker_id == null ? {} : { speaker_id: item.speaker_id }),
        };
      })
      .filter((row) => row.text);
    if (rows.length) {
      return rows;
    }
  }
  return [];
}

export function validateSubtitles(rows) {
  let previousStart = -Infinity;
  rows.forEach((row, index) => {
    if (
      !Number.isFinite(row.start) ||
      !Number.isFinite(row.end) ||
      row.start < 0 ||
      row.end < row.start
    ) {
      throw new CliError(
        `Invalid subtitle timeline at cue ${index + 1}: start=${row.start}, end=${row.end}`,
      );
    }
    if (row.start < previousStart) {
      throw new CliError(
        `Subtitle timeline regressed at cue ${index + 1}: ${row.start} < ${previousStart}`,
      );
    }
    previousStart = row.start;
  });
}

export function slugify(inputValue, title = null) {
  const source = title || inputValue.replace(/\/+$/, "").split("/").at(-1) || "media-content";
  const normalized = source
    .replace(/[^\w\u4e00-\u9fff-]+/gu, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  return normalized || "media-content";
}

export function sourceId(inputValue) {
  const bvid = String(inputValue).match(/(BV[0-9A-Za-z]+)/);
  if (bvid) {
    return bvid[1];
  }
  try {
    const parsed = new URL(inputValue);
    const tail = parsed.pathname.replace(/\/+$/, "").split("/").at(-1) || "";
    const candidate = tail
      .replace(/[^\w-]+/g, "-")
      .replace(/^[-_]+|[-_]+$/g, "");
    if (candidate && candidate.length <= 48) {
      return candidate;
    }
  } catch {
    // Local paths use a stable digest below.
  }
  return `source-${crypto.createHash("sha1").update(String(inputValue)).digest("hex").slice(0, 12)}`;
}

function titleFromResponse(response) {
  const detail = response?.detail && typeof response.detail === "object" ? response.detail : {};
  return detail.title || response?.title || null;
}

export function responseMetadata(response, { inputValue, transport }) {
  const detail = response?.detail && typeof response.detail === "object" ? response.detail : {};
  const sourceUrl = detail.url || response?.sourceUrl || inputValue;
  return {
    success: response?.success ?? null,
    id: response?.id ?? null,
    service: response?.service ?? null,
    platform: response?.service ?? null,
    url: redactString(String(sourceUrl)),
    sourceUrl: response?.sourceUrl
      ? redactString(String(response.sourceUrl))
      : redactString(String(inputValue)),
    title: detail.title ?? response?.title ?? null,
    author: detail.author ?? response?.author ?? null,
    duration: detail.duration ?? response?.duration ?? null,
    durationSec: detail.duration ?? response?.duration ?? null,
    subtitleSource:
      detail.subtitleSource ||
      detail.subtitleUrl ||
      "BibiGPT official /v1/getSubtitle",
    apiMode: "subtitle-only",
    operation: "getSubtitle",
    transport,
    costDuration: response?.costDuration ?? null,
    remainingTime: response?.remainingTime ?? null,
    remainingMinutes: remainingMinutes(response),
    fromCache: response?.fromCache ?? null,
  };
}

function chooseMainProductPath(outputDirectory, titleSlug, artifactId) {
  const candidate = path.join(outputDirectory, `${titleSlug}.md`);
  if (!fs.existsSync(candidate)) {
    return candidate;
  }
  const text = fs.readFileSync(candidate, "utf8");
  return text.includes(artifactId)
    ? candidate
    : path.join(outputDirectory, `${titleSlug}-${artifactId}.md`);
}

export function writeResponseArtifacts(outputDirectory, inputValue, response, transport = "api") {
  ensureDir(outputDirectory);
  const metadata = responseMetadata(response, { inputValue, transport });
  const artifactId = sourceId(inputValue);
  const artifactDirectory = path.join(outputDirectory, artifactId);
  ensureDir(artifactDirectory);
  const titleSlug = slugify(inputValue, metadata.title);
  const mainProductPath = chooseMainProductPath(outputDirectory, titleSlug, artifactId);
  const rawSubtitlePath = path.join(artifactDirectory, "raw-subtitle.json");
  const metadataPath = path.join(artifactDirectory, "metadata.json");
  const enrichedMetadata = {
    ...metadata,
    artifactId,
    artifactDir: artifactDirectory,
    mainProduct: path.basename(mainProductPath),
    artifactLayout: "root-main-product/source-id-sidecars",
  };
  writeJson(rawSubtitlePath, safeJson(response));
  writeJson(metadataPath, safeJson(enrichedMetadata));
  return {
    artifactId,
    artifactDirectory,
    titleSlug,
    mainProductPath,
    rawSubtitlePath,
    metadataPath,
    metadata: enrichedMetadata,
    outputDirectory,
  };
}

export function formatTime(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secondsPart = total % 60;
  const pad = (value) => String(value).padStart(2, "0");
  return hours ? `${pad(hours)}:${pad(minutes)}:${pad(secondsPart)}` : `${pad(minutes)}:${pad(secondsPart)}`;
}

function resolvedSeparator(separator = "linebreak") {
  if (separator === "linebreak" || separator === "newline" || separator === "\\n") {
    return "\n";
  }
  if (separator === "space") {
    return " ";
  }
  return separator;
}

export function joinSubtitleText(parts, separator = "linebreak") {
  const cleaned = parts.map((part) => String(part || "").trim()).filter(Boolean);
  if (!cleaned.length) {
    return "";
  }
  const resolved = resolvedSeparator(separator);
  return resolved === "|" ? cleaned.join(" | ") : cleaned.join(resolved);
}

export function compactRows(rows, sentencesPerGroup = 10, sentenceSeparator = "linebreak") {
  if (!Number.isInteger(Number(sentencesPerGroup)) || Number(sentencesPerGroup) < 1) {
    throw new CliError("--sentences-per-group must be at least 1");
  }
  const groups = [];
  for (let offset = 0; offset < rows.length; offset += Number(sentencesPerGroup)) {
    const chunk = rows.slice(offset, offset + Number(sentencesPerGroup));
    groups.push({
      index: groups.length,
      start: chunk[0].start,
      end: chunk.at(-1).end,
      startCue: chunk[0].index,
      endCue: chunk.at(-1).index,
      sentenceCount: chunk.length,
      text: joinSubtitleText(
        chunk.map((row) => row.text),
        sentenceSeparator,
      ),
    });
  }
  return groups;
}

function separatorDescription(separator) {
  const resolved = resolvedSeparator(separator);
  if (resolved === "\n") return "换行";
  if (resolved === " ") return "空格";
  if (resolved === "|") return "竖线（|）";
  return `自定义分隔符 \`${resolved}\``;
}

export function findMetadata(raw) {
  const value = unwrapJson(raw);
  const payload = findPayload(
    value,
    (item) =>
      item &&
      typeof item === "object" &&
      ["title", "url", "sourceUrl", "duration", "author"].some((key) => key in item),
  );
  const result = payload && typeof payload === "object" ? { ...payload } : {};
  if (value && typeof value === "object" && value.detail && typeof value.detail === "object") {
    Object.assign(result, value, value.detail);
  }
  if (!result.url) {
    result.url = result.sourceUrl;
  }
  return result;
}

export function renderTranscript(meta, rows, options = {}) {
  const sentencesPerGroup = Number(options.sentencesPerGroup || 10);
  const separator = options.sentenceSeparator || "linebreak";
  const groups = compactRows(rows, sentencesPerGroup, separator);
  const title = meta.title || "Untitled media";
  const duration = asNumber(meta.duration ?? meta.durationSec);
  const first = rows[0]?.start ?? 0;
  const last = rows.at(-1)?.end ?? 0;
  const coverage =
    duration > 0
      ? first <= 1 && Math.max(0, duration - last) <= Math.max(5, duration * 0.03)
        ? "看起来覆盖完整（仍建议抽查尾部）"
        : `部分覆盖：首条 ${formatTime(first)}，末条 ${formatTime(last)}，距视频时长约 ${Math.max(0, duration - last).toFixed(1)} 秒`
      : `已获取 ${rows.length} 条 cue，覆盖 ${formatTime(first)}–${formatTime(last)}`;
  const lines = [
    `# ${title}｜时间轴转录`,
    "",
    `> 本文由字幕 JSON 排版生成；每 ${sentencesPerGroup} 条 cue 合并一个时间段，组内 cue 之间使用${separatorDescription(separator)}分隔，未对原文进行静默改写。`,
    "> “覆盖完整”仅表示时间轴检查结果，仍建议抽查视频尾部。",
    "",
    "## 视频信息",
    "",
    `- 原始链接：${meta.url || meta.sourceUrl || "未提供"}`,
    `- 平台/服务：${meta.service || meta.platform || "未提供"}`,
    `- 作者：${meta.author || "未提供"}`,
    `- 时长：${formatTime(duration)}`,
    `- 字幕来源：${meta.subtitleSource || "BibiGPT getSubtitle"}`,
    `- 获取方式：${meta.transport || meta.apiMode || "未提供"}`,
    `- 原始字幕 cue：${rows.length} 条`,
    `- 合并后时间段：${groups.length} 段（每段最多 ${sentencesPerGroup} 条）`,
    `- cue 分隔方式：${separatorDescription(separator)}`,
    `- 首条/末条：${formatTime(rows[0]?.start)}–${formatTime(rows.at(-1)?.end)}`,
    `- 覆盖判断：${coverage}`,
    "",
    "## 时间轴转录",
    "",
  ];
  for (const group of groups) {
    lines.push(`### ${formatTime(group.start)}–${formatTime(group.end)}`);
    lines.push(group.text);
    lines.push("");
  }
  return `${lines.join("\n").trim()}\n`;
}

function writeArtifactReadmes(outputDirectory, artifact, inputValue) {
  const artifactDirectory = artifact.artifactDirectory;
  const title = artifact.metadata.title || artifact.titleSlug;
  const sourceUrl = artifact.metadata.url || artifact.metadata.sourceUrl || inputValue;
  fs.writeFileSync(
    path.join(artifactDirectory, "README.md"),
    [
      `# ${artifact.artifactId} 字幕副产物`,
      "",
      `- 来源：[${title}](${sourceUrl})`,
      `- 主产物：[\`${path.basename(artifact.mainProductPath)}\`](../${path.basename(artifact.mainProductPath)})`,
      "",
      "## 副产物",
      "",
      "- [`raw-subtitle.json`](raw-subtitle.json)：脱敏后的字幕接口原始响应。",
      "- [`metadata.json`](metadata.json)：标题、作者、时长、来源和获取方式。",
      "- [`transcript.md`](transcript.md)：可回查的时间轴转录。",
      "- [`status.json`](status.json)：字幕获取状态和非敏感响应摘要。",
      "",
      "> 主产物放在 `media-artifacts/` 根目录；本目录只保留复核和追溯所需的副产物。",
      "",
    ].join("\n"),
    "utf8",
  );
  const rootReadme = path.join(outputDirectory, "README.md");
  const existing = fs.existsSync(rootReadme) ? fs.readFileSync(rootReadme, "utf8") : "";
  const marker = "<!-- media-content-distiller:index -->";
  const endMarker = "<!-- /media-content-distiller:index -->";
  const entry = `- [\`${path.basename(artifact.mainProductPath)}\`](${path.basename(artifact.mainProductPath)}): ${title}; [subtitle sidecars](${artifact.artifactId}/README.md).`;
  let indexLines = [];
  if (existing.includes(marker) && existing.includes(endMarker)) {
    const block = existing.split(marker)[1].split(endMarker)[0];
    indexLines = block.split(/\r?\n/).filter(
      (line) => line.startsWith("- [") && !line.includes(`](${artifact.artifactId}/README.md)`),
    );
  }
  indexLines.push(entry);
  const newBlock = [
    marker,
    "## media-content-distiller 产物索引",
    "",
    "主产物直接放在本目录根部；原始字幕、元数据、转录和状态放在对应来源 ID 文件夹。",
    "",
    ...Array.from(new Set(indexLines)).sort((a, b) => a.localeCompare(b)),
    "",
    endMarker,
  ].join("\n");
  let updated;
  if (existing.includes(marker) && existing.includes(endMarker)) {
    const before = existing.split(marker)[0].trimEnd();
    const after = existing.split(endMarker)[1].trimStart();
    updated = `${before}\n\n${newBlock}\n\n${after}`.trimEnd() + "\n";
  } else {
    updated = `${existing.trimEnd()}\n\n${newBlock}\n`.replace(/^\n+/, "");
  }
  fs.writeFileSync(rootReadme, updated, "utf8");
}

export function finalizeArtifacts(artifact, response, inputValue, options = {}) {
  const rows = normalizeSubtitles(response);
  if (!rows.length) {
    throw new CliError("Subtitle response contained no recognized cues; no partial transcript was written");
  }
  validateSubtitles(rows);
  const transcriptPath = path.join(artifact.artifactDirectory, "transcript.md");
  fs.writeFileSync(
    transcriptPath,
    renderTranscript(artifact.metadata, rows, options),
    "utf8",
  );
  writeJson(path.join(artifact.artifactDirectory, "status.json"), {
    command: options.command || "subtitle",
    status: "transcript_ready",
    accountId: options.accountId || null,
    input: redactString(inputValue),
    response: responseMetadata(response, {
      inputValue,
      transport: options.transport || "api",
    }),
    savedAt: nowIso(),
  });
  writeArtifactReadmes(artifact.outputDirectory || path.dirname(artifact.artifactDirectory), artifact, inputValue);
  return { transcriptPath, cueCount: rows.length };
}

export function isUrl(value) {
  return /^https?:\/\//i.test(String(value).trim());
}

export function readBatchInput(filePath) {
  const records = [];
  for (const [lineNumber, rawLine] of fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      throw new CliError(`Batch input line ${lineNumber + 1} is not valid JSON`);
    }
    if (typeof value === "string") {
      value = { input: value };
    }
    if (!value || typeof value !== "object") {
      throw new CliError(`Batch input line ${lineNumber + 1} must be a string or object`);
    }
    const input = String(value.input || value.url || "").trim();
    if (!input) {
      throw new CliError(`Batch input line ${lineNumber + 1} has no input/url`);
    }
    records.push({ ...value, input });
  }
  return records;
}

export function sourceKey(inputValue) {
  const bvid = String(inputValue).match(/(BV[0-9A-Za-z]+)/);
  return bvid ? bvid[1] : String(inputValue).replace(/\/+$/, "");
}
