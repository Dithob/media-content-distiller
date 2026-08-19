import fs from "node:fs";
import path from "node:path";
import {
  ApiError,
  CLI_VERSION,
  CliError,
  DEFAULT_BASE_URL,
  ENV_TOKEN_KEY,
  discoverDotenv,
  discoverRegistry,
  finalizeArtifacts,
  findMetadata,
  isUrl,
  loadRegistry,
  normalizeSubtitles,
  parseArgs,
  readBatchInput,
  readJson,
  readDotenvValue,
  renderTranscript,
  remainingMinutes,
  requestJson,
  resolvePathReference,
  resolveToken,
  responseMetadata,
  safeJson,
  saveRegistry,
  setupRegistry,
  sourceId,
  sourceKey,
  validateSubtitles,
  writeEnvPointer,
  writeJson,
  writeResponseArtifacts,
  newRegistry,
  defaultRegistryPath,
  nowIso,
} from "./core.mjs";

export const HELP = `media-content-distiller ${CLI_VERSION}

Subtitle-first media acquisition and transcript rendering for Codex.

Usage:
  media-content-distiller <command> [options]

Commands:
  setup       Hidden-input first-use Token setup in a project registry
  init        Create an empty project registry
  bind        Bind an existing registry to a project .env
  repair      Repair the .env registry pointer or initialize it
  add         Add one authorized Token to an existing registry
  import      Import authorized Tokens from a text/JSON file
  list        List registry status without printing Tokens
  check       Check local credential sources without network access
  disable     Clear one registry slot
  me          Preflight the BibiGPT account and remaining minutes
  subtitle    Fetch public-URL subtitles and write transcript sidecars
  batch       Fetch a JSONL list of URLs serially and write a manifest
  normalize   Normalize a local subtitle JSON artifact
  render      Render a local subtitle JSON artifact
  version     Print the CLI version

Examples:
  media-content-distiller setup --registry ./accounts.json --env-file ./.env --acknowledge-plaintext-token-storage
  media-content-distiller subtitle --url "https://example.com/video" --output-dir ./media-artifacts
  media-content-distiller render --subtitle ./raw.json --out-dir ./media-artifacts/source-id

Runtime:
  Node.js >= 18 is required. No Python or third-party npm package is required.
`;

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function inputValue(options, { batch = false } = {}) {
  const value = batch
    ? options.inputFile || options.input
    : options.input || options.url || options._[0];
  if (!value) {
    throw new CliError(
      batch
        ? "batch requires --input-file <file>"
        : "subtitle requires --input/--url <public media URL>",
    );
  }
  return value;
}

function commonOptions(options) {
  return {
    ...options,
    baseUrl: options.baseUrl || DEFAULT_BASE_URL,
    timeout: Number(options.timeout || 90),
    retries: Number(options.retries ?? 2),
  };
}

async function commandSetup(options) {
  printJson(await setupRegistry(options));
}

function commandInit(options) {
  const registry = resolvePathReference(options.registry || "./accounts.json");
  if (fs.existsSync(registry) && !options.force) {
    throw new CliError(`File already exists: ${registry}; use --force to overwrite`);
  }
  const slots = options.slots === undefined ? 1 : Number(options.slots);
  saveRegistry(registry, newRegistry(slots));
  printJson({ created: registry, slots });
}

function commandBind(options) {
  const registry = resolvePathReference(options.registry || "./accounts.json");
  const envFile = resolvePathReference(options.envFile || "./.env");
  loadRegistry(registry);
  writeEnvPointer(envFile, registry);
  printJson({ bound: true, registry, envFile, tokenStored: false });
}

async function commandRepair(options) {
  const envFile = resolvePathReference(options.envFile || "./.env");
  const registry = resolvePathReference(options.registry || defaultRegistryPath(envFile));
  if (fs.existsSync(registry)) {
    commandBind({ ...options, registry, envFile });
    return;
  }
  if (options.noPrompt) {
    throw new CliError(`Registry not found: ${registry}; use setup or allow interactive import`);
  }
  printJson(
    await setupRegistry({
      ...options,
      registry,
      envFile,
    }),
  );
}

async function commandAdd(options) {
  if (!options.accountId) {
    throw new CliError("add requires --account-id <id>");
  }
  if (!options.registry) {
    throw new CliError("add requires --registry <accounts.json>");
  }
  if (!options.acknowledgePlaintextTokenStorage) {
    throw new CliError("add requires --acknowledge-plaintext-token-storage");
  }
  const registryFile = resolvePathReference(options.registry);
  const registry = loadRegistry(registryFile);
  const account = registry.accounts.find((candidate) => candidate.id === options.accountId);
  if (!account) {
    throw new CliError(`Account slot not found: ${options.accountId}`);
  }
  if (account.api_token && !options.replace) {
    throw new CliError("That slot already has a Token; use --replace to overwrite");
  }
  const { readToken } = await import("./core.mjs");
  const token = await readToken({ tokenStdin: Boolean(options.tokenStdin) });
  account.api_token = token;
  account.remaining_minutes = null;
  saveRegistry(registryFile, registry);
  printJson({
    updated: account.id,
    tokenStored: true,
    tokenPrinted: false,
    pathMode: "project-registry-0600",
    balance: "unknown-until-preflight",
  });
}

function parseTokenInput(filePath) {
  const text = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  if (text.trimStart().startsWith("{")) {
    const value = JSON.parse(text);
    if (!Array.isArray(value.accounts)) {
      throw new CliError("JSON Token input must contain an accounts array");
    }
    return value.accounts
      .map((account) => String(account?.api_token || "").trim())
      .filter(Boolean);
  }
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function commandImport(options) {
  if (!options.input) {
    throw new CliError("import requires --input <tokens.txt|accounts.json>");
  }
  if (!options.acknowledgePlaintextTokenStorage) {
    throw new CliError("import requires --acknowledge-plaintext-token-storage");
  }
  const envFile = resolvePathReference(options.envFile || "./.env");
  const registryFile = resolvePathReference(options.registry || defaultRegistryPath(envFile));
  const registry = fs.existsSync(registryFile)
    ? loadRegistry(registryFile)
    : newRegistry(0);
  const existing = new Set(registry.accounts.map((account) => account.api_token).filter(Boolean));
  const imported = [];
  let skippedDuplicates = 0;
  for (const token of parseTokenInput(resolvePathReference(options.input))) {
    if (/\s/.test(token)) {
      throw new CliError("Each Token input line must contain exactly one non-whitespace Token");
    }
    if (existing.has(token)) {
      skippedDuplicates += 1;
      continue;
    }
    let account = registry.accounts.find((candidate) => !candidate.api_token);
    if (!account) {
      account = {
        id: `account-${String(registry.accounts.length + 1).padStart(2, "0")}`,
        api_token: null,
        remaining_minutes: null,
      };
      registry.accounts.push(account);
    }
    account.api_token = token;
    account.remaining_minutes = null;
    existing.add(token);
    imported.push(account.id);
  }
  if (imported.length) {
    saveRegistry(registryFile, registry);
    writeEnvPointer(envFile, registryFile);
  }
  printJson({
    imported: imported.length,
    skippedDuplicates,
    registry: registryFile,
    envFile,
    accountIds: imported,
    tokenStored: imported.length > 0,
    tokenPrinted: false,
  });
}

function commandList(options) {
  if (!options.registry) {
    throw new CliError("list requires --registry <accounts.json>");
  }
  const registry = loadRegistry(resolvePathReference(options.registry));
  printJson({
    provider: registry.provider,
    accounts: registry.accounts.map((account) => ({
      id: account.id,
      label: account.label,
      hasToken: Boolean(account.api_token),
      remainingMinutes: account.remaining_minutes,
    })),
  });
}

function commandCheck(options) {
  const envFile = options.envFile
    ? resolvePathReference(options.envFile)
    : discoverDotenv();
  const discovered = discoverRegistry({ envFile });
  const accounts = [];
  if (discovered.registry && fs.existsSync(discovered.registry)) {
    try {
      const registry = loadRegistry(discovered.registry);
      for (const account of registry.accounts) {
        accounts.push({
          id: account.id,
          hasToken: Boolean(account.api_token),
          remainingMinutes: account.remaining_minutes,
        });
      }
    } catch {
      // Keep check diagnostic and secret-free even when a registry is malformed.
    }
  }
  const hasEnvToken = Boolean(process.env[ENV_TOKEN_KEY]?.trim());
  const hasDotenvToken = Boolean(envFile && readDotenvValue(envFile, ENV_TOKEN_KEY)?.trim());
  const hasRegistryToken = accounts.some((account) => account.hasToken);
  printJson({
    provider: "bibigpt",
    mode: hasRegistryToken || hasEnvToken || hasDotenvToken ? "api" : "unconfigured",
    transport: "api",
    sources: [
      {
        kind: "env",
        path: null,
        hasToken: hasEnvToken,
        accountId: null,
        remainingMinutes: null,
      },
      {
        kind: "dotenv",
        path: envFile,
        hasToken: hasDotenvToken,
        accountId: null,
        remainingMinutes: null,
      },
      {
        kind: "accounts-file",
        path: discovered.registry,
        accounts,
      },
    ],
  });
}

function commandDisable(options) {
  if (!options.registry || !options.accountId) {
    throw new CliError("disable requires --registry <accounts.json> and --account-id <id>");
  }
  const registryFile = resolvePathReference(options.registry);
  const registry = loadRegistry(registryFile);
  const account = registry.accounts.find((candidate) => candidate.id === options.accountId);
  if (!account) {
    throw new CliError(`Account slot not found: ${options.accountId}`);
  }
  account.api_token = null;
  account.remaining_minutes = 0;
  saveRegistry(registryFile, registry);
  printJson({ disabled: account.id, tokenCleared: true });
}

async function commandMe(options) {
  const resolved = await resolveToken(options);
  const result = await requestJson(
    options.baseUrl,
    "/v1/me",
    resolved.token,
    options,
  );
  if (resolved.registryFile && resolved.accountId) {
    const registry = loadRegistry(resolved.registryFile);
    const account = registry.accounts.find((candidate) => candidate.id === resolved.accountId);
    if (account) {
      account.remaining_minutes =
        result.data?.remainingMinutes ?? result.data?.remaining_minutes ?? null;
      saveRegistry(resolved.registryFile, registry);
    }
  }
  printJson({
    status: result.status,
    accountId: resolved.accountId,
    plan: result.data?.plan ?? null,
    remainingMinutes:
      result.data?.remainingMinutes ?? result.data?.remaining_minutes ?? null,
  });
}

function updateRegistryBalance(registryFile, accountId, remaining) {
  if (!registryFile || !accountId) {
    return;
  }
  const registry = loadRegistry(registryFile);
  const account = registry.accounts.find((candidate) => candidate.id === accountId);
  if (!account) {
    return;
  }
  account.remaining_minutes = remaining == null ? null : Number(remaining);
  saveRegistry(registryFile, registry);
}

async function acquireViaApi(input, options, resolved, { preflight = true } = {}) {
  if (!isUrl(input)) {
    throw new CliError(
      "BibiGPT API subtitle acquisition accepts public URLs only; local media files are not uploaded. Provide a public media URL.",
    );
  }
  const credentials = resolved || (await resolveToken(options));
  let remaining = null;
  if (preflight) {
    const me = await requestJson(options.baseUrl, "/v1/me", credentials.token, options);
    remaining = me.data?.remainingMinutes ?? me.data?.remaining_minutes ?? null;
    if (remaining != null && Number(remaining) <= 0) {
      throw new ApiError(402, { message: "API remainingMinutes <= 0" });
    }
    updateRegistryBalance(credentials.registryFile, credentials.accountId, remaining);
  }
  const result = await requestJson(options.baseUrl, "/v1/getSubtitle", credentials.token, {
    ...options,
    query: {
      url: input,
      audioLanguage: options.audioLanguage,
      enabledSpeaker: options.enabledSpeaker,
      transcribeProvider: options.transcribeProvider,
      whisperPrompt: options.whisperPrompt,
    },
  });
  return {
    response: result.data,
    transport: "api",
    accountId: credentials.accountId || null,
    registryFile: credentials.registryFile || null,
  };
}

async function acquireOne(input, options, resolved = null, { preflight = true } = {}) {
  const acquisition = await acquireViaApi(input, options, resolved, { preflight });

  const {
    response,
    transport,
    accountId,
    registryFile,
  } = acquisition;
  const artifact = writeResponseArtifacts(
    path.resolve(options.outputDir || "./media-artifacts"),
    input,
    response,
    transport,
  );
  artifact.outputDirectory = path.resolve(options.outputDir || "./media-artifacts");
  const final = finalizeArtifacts(artifact, response, input, {
    accountId,
    command: options.command || "subtitle",
    transport,
    sentencesPerGroup: Number(options.sentencesPerGroup || 10),
    sentenceSeparator: options.sentenceSeparator || "linebreak",
  });
  return {
    status: 200,
    requestedCommand: options.command || "subtitle",
    mode: "subtitle-only",
    synthesis: "codex-after-subtitle",
    artifactId: artifact.artifactId,
    artifactDir: artifact.artifactDirectory,
    mainProduct: artifact.mainProductPath,
    outputDir: artifact.outputDirectory,
    transcript: final.transcriptPath,
    artifacts: {
      rawSubtitle: artifact.rawSubtitlePath,
      metadata: artifact.metadataPath,
      status: path.join(artifact.artifactDirectory, "status.json"),
      folderReadme: path.join(artifact.artifactDirectory, "README.md"),
      rootReadme: path.join(artifact.outputDirectory, "README.md"),
    },
    cueCount: final.cueCount,
    response: responseMetadata(response, { inputValue: input, transport }),
  };
}

async function commandSubtitle(options, command = "subtitle") {
  const input = inputValue(options);
  const normalized = commonOptions({ ...options, command });
  printJson(await acquireOne(input, normalized, null, { preflight: true }));
}

async function commandBatch(options) {
  const inputFile = resolvePathReference(inputValue(options, { batch: true }));
  const records = readBatchInput(inputFile);
  const unique = [];
  const seen = new Set();
  for (const record of records) {
    const key = sourceKey(record.input);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(record);
    }
  }
  const localRecords = unique.filter((record) => !isUrl(record.input));
  if (localRecords.length) {
    throw new CliError(
      "Batch subtitle acquisition accepts public URLs only; local media files are not uploaded. Replace local paths with public media URLs.",
    );
  }
  const outputDirectory = path.resolve(options.outputDir || "./media-artifacts");
  const manifestFile = path.resolve(options.manifest || path.join(outputDirectory, "batch-manifest.json"));
  fs.mkdirSync(outputDirectory, { recursive: true });
  const manifest = fs.existsSync(manifestFile)
    ? readJson(manifestFile)
    : { version: 2, operation: "getSubtitle", items: {} };
  manifest.items = manifest.items || {};
  manifest.version = 2;
  manifest.operation = "getSubtitle";
  manifest.input = inputFile;
  manifest.updatedAt = nowIso();
  writeJson(manifestFile, manifest);

  const hasTranscriptArtifact = (input) => {
    const artifactDirectory = path.join(outputDirectory, sourceId(input));
    return [
      "raw-subtitle.json",
      "metadata.json",
      "transcript.md",
      "status.json",
    ].every((name) => fs.existsSync(path.join(artifactDirectory, name)));
  };
  const saveManifest = () => {
    manifest.updatedAt = nowIso();
    writeJson(manifestFile, safeJson(manifest));
  };

  const resolved = unique.length ? await resolveToken(commonOptions(options)) : null;
  if (resolved) {
    const me = await requestJson(
      options.baseUrl || DEFAULT_BASE_URL,
      "/v1/me",
      resolved.token,
      commonOptions(options),
    );
    const remaining = remainingMinutes(me.data);
    if (remaining != null && Number(remaining) <= 0) {
      throw new ApiError(402, { message: "API remainingMinutes <= 0" });
    }
    updateRegistryBalance(resolved.registryFile, resolved.accountId, remaining);
    process.stdout.write(
      `${JSON.stringify({
        event: "batch_preflight",
        count: unique.length,
        operation: "getSubtitle",
        accountId: resolved.accountId,
        remainingMinutes: remaining,
      })}\n`,
    );
  }

  let processed = 0;
  let skippedCached = 0;
  let failed = 0;
  let stopped = null;
  for (const record of unique) {
    const key = sourceKey(record.input);
    const existing = manifest.items?.[key];
    if (
      !options.refresh &&
      existing?.status === "transcript_ready" &&
      hasTranscriptArtifact(record.input)
    ) {
      skippedCached += 1;
      process.stdout.write(`${JSON.stringify({ event: "skip_cached", key })}\n`);
      saveManifest();
      continue;
    }
    try {
      const itemOptions = commonOptions({
        ...options,
        ...record,
        outputDir: outputDirectory,
        command: "batch",
      });
      const result = await acquireOne(
        record.input,
        itemOptions,
        isUrl(record.input) ? resolved : null,
        { preflight: false },
      );
      manifest.items = manifest.items || {};
      manifest.items[key] = { key, input: record.input, status: "transcript_ready", ...result };
      processed += 1;
      process.stdout.write(`${JSON.stringify({ event: "item", ...manifest.items[key] })}\n`);
    } catch (error) {
      failed += 1;
      const status = error instanceof ApiError
        ? ({ 401: "auth_error", 402: "quota_exhausted", 403: "auth_error", 429: "rate_limited" }[error.status] || "manual_review")
        : "manual_review";
      manifest.items = manifest.items || {};
      manifest.items[key] = {
        key,
        input: record.input,
        status,
        httpStatus: error.status || null,
        error: error instanceof CliError ? error.message : String(error),
      };
      process.stdout.write(`${JSON.stringify({ event: "item", ...manifest.items[key] })}\n`);
      saveManifest();
      if (["auth_error", "quota_exhausted", "rate_limited"].includes(status)) {
        stopped = status;
        break;
      }
    }
    saveManifest();
  }
  process.stdout.write(
    `${JSON.stringify({
    event: "batch_complete",
    operation: "getSubtitle",
    inputCount: records.length,
    uniqueCount: unique.length,
    processed,
    skippedCached,
    failed,
    stopped,
    manifest: manifestFile,
    nextStep: "Codex can summarize, compare, or turn the generated subtitles into learning notes",
    })}\n`,
  );
}

function commandNormalize(options) {
  if (!options.input) {
    throw new CliError("normalize requires --input <subtitle.json>");
  }
  const rows = normalizeSubtitles(readJson(resolvePathReference(options.input)));
  if (!rows.length) {
    throw new CliError("No recognized subtitles found: expected subtitlesArray, subtitles, or body");
  }
  validateSubtitles(rows);
  printJson(rows);
}

function commandRender(options) {
  if (!options.subtitle || !options.outDir) {
    throw new CliError("render requires --subtitle <subtitle.json> and --out-dir <directory>");
  }
  const subtitlePath = resolvePathReference(options.subtitle);
  const rows = normalizeSubtitles(readJson(subtitlePath));
  if (!rows.length) {
    throw new CliError("No recognized subtitles found: expected subtitlesArray, subtitles, or body");
  }
  validateSubtitles(rows);
  const metadata = options.metadata
    ? findMetadata(readJson(resolvePathReference(options.metadata)))
    : findMetadata(readJson(subtitlePath));
  const outputDirectory = resolvePathReference(options.outDir);
  fs.mkdirSync(outputDirectory, { recursive: true });
  const outputName = options.outputName || "transcript.md";
  const outputPath = path.join(outputDirectory, outputName);
  fs.writeFileSync(
    outputPath,
    renderTranscript(metadata, rows, {
      sentencesPerGroup: Number(options.sentencesPerGroup || 10),
      sentenceSeparator: options.sentenceSeparator || "linebreak",
    }),
    "utf8",
  );
  printJson({
    cueCount: rows.length,
    sentencesPerGroup: Number(options.sentencesPerGroup || 10),
    sentenceSeparator: options.sentenceSeparator || "linebreak",
    outputs: [outputPath],
    synthesis: "codex-after-subtitle",
  });
}

export async function runCli(argv) {
  try {
    if (argv[0] === "--") {
      argv = argv.slice(1);
    }
    const firstArgument = argv[0] || "help";
    if (firstArgument === "-h" || firstArgument === "--help") {
      process.stdout.write(HELP);
      return 0;
    }
    if (firstArgument === "-v" || firstArgument === "--version") {
      process.stdout.write(`${CLI_VERSION}\n`);
      return 0;
    }
    const command = firstArgument;
    const options = parseArgs(argv.slice(1));
    if (command === "help" || options.help) {
      process.stdout.write(HELP);
      return 0;
    }
    if (command === "version" || options.version) {
      process.stdout.write(`${CLI_VERSION}\n`);
      return 0;
    }
    const normalized = commonOptions(options);
    if (command === "setup") await commandSetup(normalized);
    else if (command === "init") commandInit(normalized);
    else if (command === "bind") commandBind(normalized);
    else if (command === "repair") await commandRepair(normalized);
    else if (command === "add") await commandAdd(normalized);
    else if (command === "import") commandImport(normalized);
    else if (command === "list") commandList(normalized);
    else if (command === "check") commandCheck(normalized);
    else if (command === "disable") commandDisable(normalized);
    else if (command === "me") await commandMe(normalized);
    else if (command === "subtitle" || command === "summary" || command === "hybrid") {
      await commandSubtitle(normalized, command);
    } else if (command === "batch") {
      await commandBatch(normalized);
    } else if (command === "normalize") {
      commandNormalize(normalized);
    } else if (command === "render") {
      commandRender(normalized);
    } else {
      throw new CliError(`Unknown command: ${command}\n\n${HELP}`);
    }
    return 0;
  } catch (error) {
    const status = error instanceof ApiError ? error.status : null;
    const payload = {
      ok: false,
      status,
      error: error instanceof CliError ? error.message : String(error),
      retryAfter: error instanceof ApiError ? error.retryAfter : null,
    };
    process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
    return error instanceof CliError ? error.code : 1;
  }
}
