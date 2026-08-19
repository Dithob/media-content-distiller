# Media Content Distiller

Package name and skill slug: `media-content-distiller`

English | [中文](README.md)

A lightweight media subtitle and content distillation skill. For a one-off URL, call the BibiGPT subtitle API directly; use the bundled Node.js CLI when you need reusable credentials, batch processing, offline rendering, or the standard artifact layout. Codex then writes a summary, detailed explanation, structured outline, operation manual, learning note, or Q&A according to the user’s request.

> BibiGPT is used only as a subtitle provider. This skill does not depend on another skill or call BibiGPT summary endpoints.

## What changed

- **Direct API for one-off work**: a simple URL task can use `curl` without installing or starting a script pipeline.
- **Node.js CLI for reusable work**: no Python and no third-party npm package are required; Python files are compatibility forwarders for old commands.
- **Probe every Token during setup**: `setup`, `import`, and `add` probe all configured Tokens through `/v1/me`, recording authorization state, remaining quota, plan, and failure status.
- **Separate main documents from sidecars**: subtitle acquisition writes source sidecars only. Codex chooses the user-facing filename and writes the main document; timeline checks, evidence, and boundaries stay in the source directory.
- **Local media is never uploaded automatically**: the current API accepts public URLs only; existing local subtitle JSON can be processed offline.

## Installation

### Install the skill

```bash
npx skills add Dithob/media-content-distiller --skill media-content-distiller -g -y
```

### Install the CLI

Node.js 18+ is required:

```bash
git clone https://github.com/Dithob/media-content-distiller.git
cd media-content-distiller
npm install --global .
media-content-distiller --help
```

Or run it directly from the checkout:

```bash
./bin/media-content-distiller --help
```

## Quick start

### 1. Call the API directly for a one-off URL

If you only need one URL, use `curl` and do not install the CLI:

```bash
read -r -s BIBI_API_TOKEN
export BIBI_API_TOKEN
printf '\n'

umask 077
cfg="$(mktemp)"
trap 'rm -f "$cfg"' EXIT
printf 'header = "Authorization: Bearer %s"\nheader = "Accept: application/json"\n' \
  "$BIBI_API_TOKEN" >"$cfg"

curl --silent --show-error --fail-with-body \
  --config "$cfg" \
  "${BIBIGPT_BASE:-https://api.bibigpt.co/api}/v1/me"

curl --silent --show-error --fail-with-body -G \
  --config "$cfg" \
  --data-urlencode "url=$MEDIA_URL" \
  "${BIBIGPT_BASE:-https://api.bibigpt.co/api}/v1/getSubtitle"
```

Parse the `/v1/me` and `/v1/getSubtitle` JSON responses, then let Codex distill the content.
Do not call BibiGPT summary endpoints or put the Token directly in curl arguments.

### 2. Acquire subtitles and write sidecars with the CLI

```bash
media-content-distiller subtitle \
  --url "https://example.com/video" \
  --output-dir ./media-artifacts \
  --purpose "summary notes"
```

The command calls `/v1/me` and then `/v1/getSubtitle`, normalizes the subtitles, and validates the timeline. It also returns a purpose-aware main filename, using the repository's current Chinese suffix convention:

- Summary notes: `媒体标题摘要.md`
- Detailed summary: `媒体标题详细总结.md`
- Operation manual: `软件名称操作手册.md`
- Learning note: `媒体标题学习笔记.md`

### 3. Initialize and probe every Token

Interactive setup:

```bash
media-content-distiller setup \
  --registry ./accounts.json \
  --env-file ./.env \
  --acknowledge-plaintext-token-storage
```

Tokens are read through hidden input. After setup, **every configured Token** in the registry is probed through `/v1/me`. The registry records `usable`, `invalid`, `forbidden`, `quota_exhausted`, `rate_limited`, or `unavailable`, together with remaining minutes and plan information.

Batch import:

```bash
media-content-distiller import \
  --registry ./accounts.json \
  --env-file ./.env \
  --input ./tokens.txt \
  --acknowledge-plaintext-token-storage
```

Probe again later:

```bash
media-content-distiller probe --registry ./accounts.json
media-content-distiller list --registry ./accounts.json
```

`check` inspects local configuration only and does not make network requests; `probe` performs the real Token and quota check.

Secure non-interactive input:

```bash
printf '%s\n%s\n' "$TOKEN_A" "$TOKEN_B" | \
  media-content-distiller setup \
  --registry ./accounts.json \
  --env-file ./.env \
  --token-stdin \
  --acknowledge-plaintext-token-storage
```

Never put real Tokens in chat, shell history, Git, logs, or generated artifacts. The registry and `.env` are best-effort protected with `0600` permissions and ignored by `.gitignore`.

### 4. Suggest a main filename

```bash
media-content-distiller name \
  --metadata ./media-artifacts/<source-id>/metadata.json \
  --purpose "operation manual"
```

### 5. Process local subtitle JSON offline

```bash
media-content-distiller normalize --input ./raw-subtitle.json
media-content-distiller render \
  --subtitle ./raw-subtitle.json \
  --metadata ./metadata.json \
  --out-dir ./media-artifacts/source-id
```

### 6. Batch subtitle acquisition

```bash
media-content-distiller batch \
  --input ./videos.jsonl \
  --output-dir ./media-artifacts
```

Batch mode only acquires subtitles. Codex performs later summaries, comparisons, and learning-note synthesis.

### 7. Python compatibility entry points

Existing automation may continue to use:

```bash
python3 scripts/acquire_subtitle.py subtitle --input "https://example.com/video"
python3 scripts/token_registry.py probe --registry ./accounts.json
python3 scripts/render_transcript.py \
  --subtitle ./raw-subtitle.json \
  --out-dir ./media-artifacts/source-id
```

These files are wrappers around the same Node.js implementation. Without Node.js, the Python compatibility entry points do not work either; new users should not set up Python for this skill.

## Artifact layout

```text
media-artifacts/
├── README.md                         # Source index and filename suggestions
├── <main-document>.md                # Written by Codex for the actual task
└── <source-id>/
    ├── README.md                     # Sidecar navigation
    ├── raw-subtitle.json             # Redacted subtitle response
    ├── metadata.json                 # Title, source, duration, quota snapshot, etc.
    ├── transcript.md                 # Timestamped transcript
    ├── status.json                   # Acquisition status
    ├── evidence.md                   # Optional evidence notes
    ├── timeline.md                   # Optional timeline lookup
    └── boundaries.md                 # Optional limits and unknowns
```

The main document should contain what the user actually needs to read. A one-off `curl` task
does not have to persist the raw JSON, but whenever files are created, timeline details,
cue-level evidence, coverage judgments, background additions, and unknowns belong in
`<source-id>/` sidecars. The main document should only keep a short sidecar navigation section.

## API and safety boundaries

- The normal API sequence is `GET /v1/me` → `GET /v1/getSubtitle`.
- Do not call `/v1/summarize`, `/v1/summarizeWithConfig`, or `/v1/summarizeByChapter`.
- Local media paths fail before Token resolution and network access; they are never uploaded automatically.
- Stop on 401/403, exhausted quota, 429, 5xx, empty subtitles, or invalid timelines; never fabricate completion.
- Do not register accounts, collect cookies, rotate Tokens, or bypass quota/risk controls.
- Tokens, cookies, Authorization headers, and complete credential parameters must not appear in raw responses, metadata, status files, logs, main documents, or Git.

## Repository layout

```text
media-content-distiller/
├── SKILL.md
├── agents/openai.yaml
├── bin/                     # Node.js CLI entry point
├── lib/                     # CLI implementation
├── scripts/                 # Python compatibility wrappers and verification
├── references/              # API, Token, artifact, and evidence notes
├── tests/                   # Offline tests
├── package.json
├── README.md
└── README.en.md
```

## Pre-release checks

```bash
npm run test:cli
node scripts/verify_cli.mjs
PYTHONPYCACHEPREFIX=/tmp/media-content-distiller-pycache \
  python3 scripts/verify_skill.py
PYTHONPYCACHEPREFIX=/tmp/media-content-distiller-pycache \
  python3 -m unittest discover -s tests -v
git diff --check
```

Offline checks validate local code and safety boundaries only. They do not live-test a real
BibiGPT Token, quota, or current service response.

## License

MIT; see [LICENSE](LICENSE).
