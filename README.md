# QA Agent

A CLI tool that uses the Claude API to automatically generate, review, and fix Playwright tests. Built with an agentic loop pattern — Claude explores your code, writes tests, runs them, and self-heals failures without manual intervention.

## How it works

```
Your code ──> Claude reads it ──> Writes tests ──> Runs them ──> Fixes failures ──> Done
```

The agent uses a tool-use loop: Claude is given tools (`read_file`, `write_file`, `run_tests`, `list_files`) and decides which to call at each step. Your code executes the tools locally and feeds results back until Claude finishes.

```
┌─────────────────────────────────────────────┐
│  You run a command                          │
│  e.g. qa-agent generate "volume controls"   │
├─────────────────────────────────────────────┤
│  1. Snapshot project files                  │
│  2. Send to Claude with system prompt       │
│  3. Claude responds with tool calls         │
│     ├── write_file (saves tests)            │
│     ├── run_tests (runs Playwright)         │
│     ├── read errors, fix, repeat            │
│     └── done when all tests pass            │
│  4. Results stream to your terminal         │
└─────────────────────────────────────────────┘
```

## Modes

### `generate` — Write new tests

Describe a feature in plain English, and the agent writes a full Playwright test suite for it. It reads your source code, writes tests, runs them, and fixes any failures automatically.

```bash
node generate-tests.js generate "search and genre filtering" /path/to/project
```

### `review` — Audit existing tests

Analyzes your test suite against your source code and produces a detailed report covering test quality, coverage gaps, flaky patterns, and best practice violations. Saves the report as a markdown file.

```bash
node generate-tests.js review /path/to/project
```

### `fix` — Repair failing tests

Point it at a failing test file. It runs the tests, captures the errors, and sends them to Claude to diagnose and fix. Repeats until tests pass.

```bash
node generate-tests.js fix tests/my-feature.spec.ts /path/to/project
```

## Setup

```bash
# Install dependencies
npm install

# Set your API key
export ANTHROPIC_API_KEY="sk-ant-..."

# Run it
node generate-tests.js review /path/to/your/project
```

## Config file

Add a `.qa-agent.json` to any project to customize behavior:

```json
{
  "model": "claude-sonnet-4-6",
  "reviewModel": "claude-haiku-4-5-20251001",
  "files": [
    "app/app.js",
    "app/index.html",
    "tests/my-feature.spec.ts"
  ]
}
```

- **`model`** — Claude model for generate and fix modes
- **`reviewModel`** — Model for review mode (defaults to Haiku for speed)
- **`files`** — Only include these files in the snapshot (reduces tokens and cost)

You can also override files per-run:

```bash
node generate-tests.js review --files app/app.js,tests/player.spec.ts
```

## Performance optimizations

- **Project snapshots** — Source code is read upfront and included in the first message, eliminating 3-5 tool calls of exploration
- **Streaming** — Responses stream to the terminal word-by-word instead of waiting for the full response
- **Targeted files** — Config or `--files` flag limits the snapshot to relevant files, reducing token usage
- **Model selection** — Review mode uses Haiku (faster, cheaper) since it only reads and analyzes
- **Rate limit retry** — Automatic retry with backoff when hitting API rate limits

## Architecture

Built with the [Anthropic SDK](https://docs.anthropic.com/en/docs/sdks) using the Messages API with tool use. The core is a `while(true)` agent loop:

1. Send messages to Claude (with tools available)
2. If Claude responds with text → print it
3. If Claude responds with tool calls → execute them locally, send results back
4. Repeat until Claude says it's done (`stop_reason: "end_turn"`)

This is the same pattern used by Claude Code, Cursor, and other AI coding tools.

## Built with

- [Claude API](https://docs.anthropic.com/en/docs) — Anthropic's LLM API
- [Playwright](https://playwright.dev/) — Browser testing framework
- Node.js
