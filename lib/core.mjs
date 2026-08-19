import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const ENV_REGISTRY_KEY = "BIBIGPT_TOKEN_REGISTRY";
export const ENV_TOKEN_KEY = "BIBI_API_TOKEN";
export const DEFAULT_ACCOUNTS_FILE = "accounts.json";
export const LEGACY_ACCOUNTS_FILE = "accounts-tokens.json";
export const DEFAULT_BASE_URL = "https://api.bibigpt.co/api";
export const CLI_VERSION = "1.3.0";

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
    "skip-probe",
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
  return {
    id,
    api_token: null,
    remaining_minutes: null,
    probe_status: "unconfigured",
    last_checked_at: null,
    plan: null,
    last_http_status: null,
    last_error: null,
  };
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
      "User-authorized BibiGPT API tokens. Setup/import/add probe every configured token with /v1/me and save non-sensitive status/quota snapshots. Runtime selects the first usable token in registry order; do not rotate automatically.",
    selection: {
      order: "registry",
      requiresPositiveRemainingMinutes: true,
      setupProbesAllTokens: true,
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
    let remaining = account.api_token ? account.remaining_minutes : null;
    if (remaining == null || remaining === "") {
      remaining = null;
    } else {
      remaining = Number(remaining);
      if (!Number.isFinite(remaining) || remaining < 0) {
        throw new CliError(`Invalid remaining_minutes: ${id}`);
      }
    }
    const normalized = {
      id,
      api_token: token,
      remaining_minutes: remaining,
      probe_status: account.probe_status == null ? (token ? "unknown" : "unconfigured") : String(account.probe_status),
      last_checked_at: account.last_checked_at == null ? null : String(account.last_checked_at),
      plan: account.plan == null ? null : String(account.plan),
      last_http_status:
        account.last_http_status == null ? null : Number(account.last_http_status),
      last_error: account.last_error == null ? null : redactString(String(account.last_error)),
    };
    if (
      normalized.last_http_status != null &&
      !Number.isInteger(normalized.last_http_status)
    ) {
      throw new CliError(`Invalid last_http_status: ${id}`);
    }
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
    if (account.probe_status && !["unknown", "usable"].includes(account.probe_status)) {
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

function readPipedTokens() {
  return fs
    .readFileSync(0, "utf8")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
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
  const token = tokenStdin ? readPipedTokens()[0] : await readHiddenToken();
  if (!token) {
    throw new CliError("No Token was read");
  }
  if (/\s/.test(token)) {
    throw new CliError("Token must not contain whitespace");
  }
  return token;
}

export async function readTokens({ tokenStdin = false } = {}) {
  const tokens = tokenStdin ? readPipedTokens() : [await readHiddenToken()];
  if (!tokens.length) {
    throw new CliError("No Token was read");
  }
  for (const token of tokens) {
    if (/\s/.test(token)) {
      throw new CliError("Token must not contain whitespace");
    }
  }
  return tokens;
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
    : newRegistry(Number(options.slots ?? 1));
  const tokens = await readTokens({ tokenStdin: Boolean(options.tokenStdin) });
  if (options.accountId && tokens.length > 1) {
    throw new CliError("setup with --account-id accepts one Token; use --import for multiple Tokens");
  }
  if (options.accountId && options.replace && tokens.length !== 1) {
    throw new CliError("setup with --replace --account-id requires exactly one Token");
  }
  const existingTokens = new Set(
    registry.accounts.map((candidate) => candidate.api_token).filter(Boolean),
  );
  const accountIds = [];
  const existingAccountIds = [];
  for (const token of tokens) {
    if (existingTokens.has(token)) {
      const existing = registry.accounts.find((candidate) => candidate.api_token === token);
      if (existing) {
        existingAccountIds.push(existing.id);
      }
      continue;
    }
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
    account.api_token = token;
    account.remaining_minutes = null;
    account.probe_status = "unknown";
    account.last_checked_at = null;
    account.plan = null;
    account.last_http_status = null;
    account.last_error = null;
    if (options.label != null) {
      account.label = String(options.label);
    }
    existingTokens.add(token);
    accountIds.push(account.id);
    if (options.accountId) {
      break;
    }
  }
  if (!accountIds.length && !existingAccountIds.length) {
    throw new CliError("No Token was added to the registry");
  }
  saveRegistry(registryFile, registry);
  writeEnvPointer(envFile, registryFile);
  const probes = options.skipProbe
    ? []
    : await probeRegistryFile(registryFile, options);
  const allAccountIds = [...new Set([...accountIds, ...existingAccountIds])];
  return {
    initialized: true,
    registry: registryFile,
    envFile,
    accountId: allAccountIds[0],
    accountIds: allAccountIds,
    added: accountIds.length,
    tokenStored: accountIds.length > 0,
    tokenPrinted: false,
    probes,
    usableCount: probes.filter((probe) => probe.usable).length,
  };
}

function classifyProbeError(error) {
  if (!(error instanceof ApiError)) {
    return {
      status: "unavailable",
      httpStatus: null,
      error: redactString(error instanceof Error ? error.message : String(error)),
    };
  }
  const status = error.status;
  return {
    status:
      status === 401
        ? "invalid"
        : status === 403
          ? "forbidden"
          : status === 402
            ? "quota_exhausted"
            : status === 429
              ? "rate_limited"
              : status >= 500 || status === 0
                ? "unavailable"
                : "error",
    httpStatus: status || null,
    error: redactString(error.message),
  };
}

function accountProbeResult(account, fields) {
  return {
    id: account.id,
    status: fields.status,
    usable: Boolean(fields.usable),
    httpStatus: fields.httpStatus ?? null,
    plan: fields.plan ?? null,
    remainingMinutes: fields.remainingMinutes ?? null,
    checkedAt: fields.checkedAt,
    error: fields.error ?? null,
  };
}

async function probeAccount(account, options = {}) {
  const checkedAt = nowIso();
  try {
    const result = await requestJson(
      options.baseUrl || DEFAULT_BASE_URL,
      "/v1/me",
      account.api_token,
      options,
    );
    const remaining = remainingMinutes(result.data);
    const usable = remaining == null || Number(remaining) > 0;
    const status = usable ? "usable" : "quota_exhausted";
    account.remaining_minutes = remaining;
    account.probe_status = status;
    account.last_checked_at = checkedAt;
    account.plan = extractPlan(result.data);
    account.last_http_status = result.status;
    account.last_error = usable ? null : "API remainingMinutes <= 0";
    return accountProbeResult(account, {
      status,
      usable,
      httpStatus: result.status,
      plan: account.plan,
      remainingMinutes: remaining,
      checkedAt,
      error: account.last_error,
    });
  } catch (error) {
    const failure = classifyProbeError(error);
    account.remaining_minutes = failure.status === "quota_exhausted" ? 0 : null;
    account.probe_status = failure.status;
    account.last_checked_at = checkedAt;
    account.plan = null;
    account.last_http_status = failure.httpStatus;
    account.last_error = failure.error;
    return accountProbeResult(account, {
      ...failure,
      usable: false,
      checkedAt,
      remainingMinutes: account.remaining_minutes,
    });
  }
}

export async function probeRegistryFile(registryFile, options = {}) {
  const absolute = path.resolve(registryFile);
  const registry = loadRegistry(absolute);
  const probes = [];
  for (const account of registry.accounts) {
    if (!account.api_token) {
      account.probe_status = "unconfigured";
      account.remaining_minutes = null;
      account.last_checked_at = null;
      account.plan = null;
      account.last_http_status = null;
      account.last_error = null;
      continue;
    }
    probes.push(await probeAccount(account, options));
  }
  saveRegistry(absolute, registry);
  return probes;
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

export function extractPlan(response) {
  const value = unwrapJson(response);
  if (!value || typeof value !== "object") {
    return null;
  }
  for (const key of ["plan", "planName", "subscription", "tier"]) {
    if (value[key] != null && typeof value[key] !== "object") {
      return String(value[key]);
    }
  }
  return null;
}

export function remainingMinutes(response) {
  const value = unwrapJson(response);
  if (!value || typeof value !== "object") {
    return null;
  }
  for (const key of ["remainingMinutes", "remaining_minutes"]) {
    if (value[key] != null && Number.isFinite(Number(value[key]))) {
      return Number(value[key]);
    }
  }
  for (const key of ["remainingTime", "remaining_time"]) {
    if (value[key] != null && Number.isFinite(Number(value[key]))) {
      return Number(value[key]) / 60;
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

function cleanDocumentTitle(value) {
  const cleaned = slugify("", String(value || "").trim());
  return cleaned === "media-content" ? "未命名媒体" : cleaned;
}

export function suggestDocumentNames(metadata = {}, { purpose = null } = {}) {
  const title = cleanDocumentTitle(
    metadata.title || metadata.name || metadata.url || metadata.sourceUrl || "媒体内容",
  );
  const normalizedPurpose = String(purpose || "").toLowerCase();
  const subject = cleanDocumentTitle(
    metadata.subject || metadata.software || metadata.product || title,
  );
  const names = {
    summary: `${title}摘要.md`,
    detailedSummary: `${title}详细总结.md`,
    structuredSummary: `${title}结构梳理.md`,
    learningNote: `${title}学习笔记.md`,
    operationManual: `${subject}操作手册.md`,
    transcript: `${title}时间轴转录.md`,
  };
  if (/操作手册|manual|how[- ]?to|教程/.test(normalizedPurpose)) {
    names.recommended = names.operationManual;
  } else if (/学习文档|learning note|学习笔记|学习资料/.test(normalizedPurpose)) {
    names.recommended = names.learningNote;
  } else if (/详细|完整|detailed/.test(normalizedPurpose)) {
    names.recommended = names.detailedSummary;
  } else if (/结构|章节|outline|chapter/.test(normalizedPurpose)) {
    names.recommended = names.structuredSummary;
  } else if (/转录|transcript/.test(normalizedPurpose)) {
    names.recommended = names.transcript;
  } else {
    names.recommended = names.summary;
  }
  return names;
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

export function responseMetadata(response, { inputValue, transport }) {
  const value = unwrapJson(response);
  const container = value && typeof value === "object" ? value : {};
  const detail =
    container.detail && typeof container.detail === "object"
      ? container.detail
      : container;
  const sourceUrl = detail.url || container.sourceUrl || inputValue;
  return {
    success: container.success ?? null,
    id: container.id ?? null,
    service: container.service ?? null,
    platform: container.service ?? null,
    url: redactString(String(sourceUrl)),
    sourceUrl: container.sourceUrl
      ? redactString(String(container.sourceUrl))
      : redactString(String(inputValue)),
    title: detail.title ?? container.title ?? null,
    author: detail.author ?? container.author ?? null,
    duration: detail.duration ?? container.duration ?? null,
    durationSec: detail.duration ?? container.duration ?? null,
    subtitleSource: redactString(
      String(
        detail.subtitleSource ||
          detail.subtitleUrl ||
          "BibiGPT official /v1/getSubtitle",
      ),
    ),
    apiMode: "subtitle-only",
    operation: "getSubtitle",
    transport,
    costDuration: container.costDuration ?? null,
    remainingTime: container.remainingTime ?? null,
    remainingMinutes: remainingMinutes(response),
    fromCache: container.fromCache ?? null,
  };
}

export function writeResponseArtifacts(
  outputDirectory,
  inputValue,
  response,
  transport = "api",
  { purpose = null, subject = null } = {},
) {
  ensureDir(outputDirectory);
  const metadata = responseMetadata(response, { inputValue, transport });
  const artifactId = sourceId(inputValue);
  const artifactDirectory = path.join(outputDirectory, artifactId);
  ensureDir(artifactDirectory);
  const titleSlug = slugify(inputValue, metadata.title);
  const rawSubtitlePath = path.join(artifactDirectory, "raw-subtitle.json");
  const metadataPath = path.join(artifactDirectory, "metadata.json");
  const enrichedMetadata = {
    ...metadata,
    artifactId,
    artifactDir: artifactDirectory,
    artifactLayout: "root-main-products/source-id-sidecars",
    suggestedMainFiles: suggestDocumentNames({ ...metadata, subject }, { purpose }),
  };
  writeJson(rawSubtitlePath, safeJson(response));
  writeJson(metadataPath, safeJson(enrichedMetadata));
  return {
    artifactId,
    artifactDirectory,
    titleSlug,
    suggestedMainFiles: enrichedMetadata.suggestedMainFiles,
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
  const sourceUrl = redactString(String(meta.url || meta.sourceUrl || "未提供"));
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
    `- 原始链接：${sourceUrl}`,
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
      "- 主稿：由 Codex 根据用户需求写入 `media-artifacts/` 根目录；本目录不承载主稿正文。",
      `- 建议文件名：\`${artifact.suggestedMainFiles?.recommended || `${artifact.titleSlug}摘要.md`}\``,
      "",
      "## 副产物",
      "",
      "- [`raw-subtitle.json`](raw-subtitle.json)：脱敏后的字幕接口原始响应。",
      "- [`metadata.json`](metadata.json)：标题、作者、时长、来源和获取方式。",
      "- [`transcript.md`](transcript.md)：可回查的时间轴转录。",
      "- [`status.json`](status.json)：字幕获取状态和非敏感响应摘要。",
      "- `evidence.md`、`timeline.md`、`boundaries.md`：总结任务需要时写入的证据、时间轴回查和补充边界。",
      "",
      "> 时间轴、证据说明和补充边界属于副产物，不要塞进主稿正文。",
      "",
    ].join("\n"),
    "utf8",
  );
  const rootReadme = path.join(outputDirectory, "README.md");
  const existing = fs.existsSync(rootReadme) ? fs.readFileSync(rootReadme, "utf8") : "";
  const marker = "<!-- media-content-distiller:index -->";
  const endMarker = "<!-- /media-content-distiller:index -->";
  const entry = `- ${title}; [subtitle sidecars](${artifact.artifactId}/README.md); suggested main file: \`${artifact.suggestedMainFiles?.recommended || `${artifact.titleSlug}摘要.md`}\`.`;
  let indexLines = [];
  if (existing.includes(marker) && existing.includes(endMarker)) {
    const block = existing.split(marker)[1].split(endMarker)[0];
    indexLines = block
      .split(/\r?\n/)
      .filter(
        (line) =>
          line.startsWith("- ") &&
          !line.includes(`(${artifact.artifactId}/README.md)`),
      );
  }
  indexLines.push(entry);
  const newBlock = [
    marker,
    "## media-content-distiller 产物索引",
    "",
    "主稿由 Codex 写入本目录根部；原始字幕、元数据、转录和复核信息放在对应来源 ID 文件夹。",
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
