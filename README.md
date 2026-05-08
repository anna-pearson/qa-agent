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
node qa-agent.js generate "search and genre filtering" /path/to/project
```

### `review` — Audit existing tests

Analyzes your test suite against your source code and produces a detailed report covering test quality, coverage gaps, flaky patterns, and best practice violations. Saves the report as a markdown file.

```bash
node qa-agent.js review /path/to/project
```

### `fix` — Repair failing tests

Point it at a failing test file. It runs the tests, captures the errors, and sends them to Claude to diagnose and fix. Repeats until tests pass.

```bash
node qa-agent.js fix tests/my-feature.spec.ts /path/to/project
```

### `bug` — File a bug report

Describe a bug in plain English. The agent reads your source code, identifies the likely root cause, and writes a formatted GitHub issue with steps to reproduce, expected vs. actual behavior, and a suggested fix.

```bash
node qa-agent.js bug "clicking next track while paused starts playing automatically" /path/to/project
```

## Quick start

```bash
# Set your API key (get one at console.anthropic.com)
export ANTHROPIC_API_KEY="sk-ant-..."

# Run it in any project directory
npx playwright-qa-agent review
npx playwright-qa-agent generate "search filtering"
npx playwright-qa-agent fix tests/my-test.spec.ts
npx playwright-qa-agent bug "volume resets when switching tracks"
```

Or install globally:

```bash
npm install -g playwright-qa-agent
playwright-qa-agent review
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
node qa-agent.js review --files app/app.js,tests/player.spec.ts
```

## Example output

See [examples/review-output.md](examples/review-output.md) for a real review generated against a [DJ Mix Player test suite](https://github.com/anna-pearson/playwright-test-suite).

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
