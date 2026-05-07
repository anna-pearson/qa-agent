#!/usr/bin/env node
import Anthropic from "@anthropic-ai/sdk";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";

const client = new Anthropic();

// --- Load config from .qa-agent.json in the project ---
function loadConfig(projectPath) {
  const configPath = path.join(projectPath, ".qa-agent.json");
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch {
    return {}; // no config file = use defaults
  }
}

// --- Snapshot the project so Claude doesn't waste tool calls exploring ---
// If onlyFiles is provided, only include those specific files
function snapshotProject(projectPath, onlyFiles = null) {
  const lines = [];

  // Targeted mode: only read the specified files
  if (onlyFiles && onlyFiles.length > 0) {
    for (const file of onlyFiles) {
      const fullPath = path.join(projectPath, file);
      try {
        const content = fs.readFileSync(fullPath, "utf-8");
        lines.push(`\n--- ${file} ---\n${content}`);
      } catch { /* skip missing files */ }
    }
    return lines.join("\n");
  }

  // Full mode: walk the entire project
  function walk(dir, prefix = "") {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const skipDirs = ["node_modules", ".git", ".github", "playwright-report", "test-results"];
      const skipFiles = ["package-lock.json"];
      if (skipDirs.includes(entry.name)) continue;
      if (skipFiles.includes(entry.name)) continue;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), rel);
      } else if (/\.(ts|js|html|css|json)$/.test(entry.name)) {
        try {
          const content = fs.readFileSync(path.join(dir, entry.name), "utf-8");
          lines.push(`\n--- ${rel} ---\n${content}`);
        } catch { /* skip unreadable files */ }
      }
    }
  }

  walk(projectPath);
  return lines.join("\n");
}

// --- Tool definitions: what the agent can do ---
const tools = [
  {
    name: "read_file",
    description:
      "Read the contents of a file from the project. Use this to understand the app code and tests.",
    input_schema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "Path to the file, relative to the project root",
        },
      },
      required: ["file_path"],
    },
  },
  {
    name: "list_files",
    description:
      "List files in a directory. Use this to explore the project structure.",
    input_schema: {
      type: "object",
      properties: {
        directory: {
          type: "string",
          description: "Directory path relative to the project root",
        },
      },
      required: ["directory"],
    },
  },
  {
    name: "write_file",
    description:
      "Write content to a file in the project. Use this to save generated test files.",
    input_schema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "Path to the file, relative to the project root",
        },
        content: {
          type: "string",
          description: "The content to write to the file",
        },
      },
      required: ["file_path", "content"],
    },
  },
  {
    name: "run_tests",
    description:
      "Run Playwright tests and return the results. Use this after writing tests to check if they pass. You can run a specific test file or all tests.",
    input_schema: {
      type: "object",
      properties: {
        test_file: {
          type: "string",
          description:
            "Path to a specific test file relative to the project root (e.g. tests/my-feature.spec.ts). If omitted, runs all tests.",
        },
      },
    },
  },
];

// --- Tool execution: what happens when the agent calls a tool ---
function executeTool(toolName, toolInput, projectPath) {
  if (toolName === "read_file") {
    const fullPath = path.join(projectPath, toolInput.file_path);
    try {
      return fs.readFileSync(fullPath, "utf-8");
    } catch (err) {
      return `Error: Could not read file "${toolInput.file_path}" - ${err.message}`;
    }
  }

  if (toolName === "list_files") {
    const fullPath = path.join(projectPath, toolInput.directory);
    try {
      const entries = fs.readdirSync(fullPath, { withFileTypes: true });
      return entries
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .join("\n");
    } catch (err) {
      return `Error: Could not list directory "${toolInput.directory}" - ${err.message}`;
    }
  }

  if (toolName === "write_file") {
    const fullPath = path.join(projectPath, toolInput.file_path);
    try {
      const dir = path.dirname(fullPath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(fullPath, toolInput.content);
      return `Successfully wrote ${toolInput.content.length} chars to ${toolInput.file_path}`;
    } catch (err) {
      return `Error: Could not write file "${toolInput.file_path}" - ${err.message}`;
    }
  }

  if (toolName === "run_tests") {
    const testPath = toolInput.test_file || "";
    const cmd = `npx playwright test ${testPath} --reporter=list 2>&1`;
    try {
      const output = execSync(cmd, {
        cwd: projectPath,
        timeout: 120000,
        encoding: "utf-8",
      });
      return output;
    } catch (err) {
      // Playwright exits with code 1 when tests fail — that's expected
      return err.stdout || err.stderr || `Test run error: ${err.message}`;
    }
  }

  return `Unknown tool: ${toolName}`;
}

// --- System prompts for each mode ---
const SYSTEM_PROMPTS = {
  generate: `You are a senior QA engineer who writes Playwright tests.

The full project source code is provided in the first message — do NOT use list_files or read_file to explore. Go straight to writing tests.

Your process:
1. Read the provided source code to understand the feature
2. Write comprehensive Playwright tests that cover:
   - Happy path (normal usage)
   - Edge cases
   - Error states
   - Accessibility basics (roles, labels)
3. Save the test file using write_file to the tests/ directory as a .spec.ts file
4. Run the tests using run_tests to see if they pass
5. If any tests fail, read the error output carefully, fix the tests and write the updated file
6. Run the tests again. Repeat until all tests pass or you've tried 3 fix attempts.

Use modern Playwright best practices:
- Use getByRole, getByText, getByTestId over CSS selectors
- Use web-first assertions (toBeVisible, toHaveText, etc.)
- Use test.describe for grouping
- Keep tests independent of each other

When fixing failing tests, fix your test assumptions to match the actual app behavior — do NOT remove tests just to make the suite pass. Only remove a test if the feature genuinely doesn't exist.`,

  review: `You are a senior QA engineer reviewing Playwright tests.

The full project source code and test files are provided in the first message — do NOT use list_files or read_file to explore. Go straight to your review.

Your process:
1. Read the provided source code and test files
2. Compare the two and provide a thorough review

Your review should cover:

**Test Quality**
- Flaky patterns (race conditions, timing issues, brittle selectors)
- Deprecated or outdated Playwright APIs
- Tests that depend on each other (shared state)
- Missing assertions (actions without verification)
- Overly broad or overly specific selectors

**Coverage Gaps**
- Features in the source code that have no tests
- Happy paths that are missing
- Edge cases not covered (empty states, boundaries, errors)
- Accessibility not tested (keyboard nav, ARIA roles, screen readers)

**Best Practices**
- Are they using getByRole/getByText over CSS selectors?
- Are assertions web-first (toBeVisible vs manual waits)?
- Is test grouping logical (test.describe)?
- Are test names descriptive?

Format your review as:
1. A summary (overall health of the test suite)
2. Critical issues (things that will cause failures or flakiness)
3. Coverage gaps (what's not tested that should be)
4. Suggestions (improvements, not blockers)

Be specific — reference file names, line numbers, and exact code.`,

  fix: `You are a senior QA engineer who fixes failing Playwright tests.

The full project source code, test files, and failure logs are provided in the first message.

Your process:
1. Read the failure output carefully — understand WHY each test failed
2. Read the relevant source code to understand the actual app behavior
3. Fix the tests so they match real app behavior — update selectors, assertions, or test logic
4. Save the fixed test file using write_file
5. Run the tests using run_tests to verify they pass
6. If tests still fail, read the errors, fix again, and re-run. Repeat up to 3 times.

Rules:
- Fix your TEST code to match the app, not the other way around
- Do NOT delete tests unless the feature genuinely doesn't exist
- Do NOT add waits or timeouts to paper over race conditions — fix the root cause
- Explain what was wrong and what you changed`,

  bug: `You are a senior QA engineer writing a bug report.

The full project source code is provided in the first message, along with a description of the bug.

Your process:
1. Read the source code to understand how the feature works
2. Identify the likely root cause in the code
3. Write a clear, professional GitHub issue in this exact format:

## Description
A clear summary of the bug in 1-2 sentences.

## Steps to Reproduce
1. Step one
2. Step two
3. Step three

## Expected Behavior
What should happen.

## Actual Behavior
What happens instead.

## Root Cause Analysis
Where in the code the bug likely originates. Reference specific files and line numbers.

## Suggested Fix
A brief description of how to fix it, with code snippets if helpful.

## Severity
One of: Critical / High / Medium / Low

Rules:
- Be specific — reference exact files, functions, and line numbers
- Steps to reproduce should be detailed enough for anyone to follow
- Root cause analysis should point to actual code, not guesses
- Keep the tone professional and objective`,
};

// --- Human-readable tool logging ---
function describeToolCall(name, input) {
  switch (name) {
    case "read_file":
      return `Reading ${input.file_path}...`;
    case "list_files":
      return `Listing files in ${input.directory}...`;
    case "write_file":
      return `Writing ${input.file_path}...`;
    case "run_tests":
      return input.test_file
        ? `Running tests: ${input.test_file}...`
        : `Running all tests...`;
    default:
      return `${name}...`;
  }
}

function describeToolResult(name, input, result) {
  switch (name) {
    case "read_file":
      return `Done - read ${input.file_path}`;
    case "list_files": {
      const count = result.split("\n").filter(Boolean).length;
      return `Done - found ${count} items in ${input.directory}`;
    }
    case "write_file":
      return result.startsWith("Successfully")
        ? `Done - saved ${input.file_path}`
        : `FAILED to write ${input.file_path}`;
    case "run_tests": {
      const passMatch = result.match(/(\d+) passed/);
      const failMatch = result.match(/(\d+) failed/);
      const passed = passMatch ? passMatch[1] : 0;
      const failed = failMatch ? failMatch[1] : 0;
      if (failed > 0) {
        return `${passed} passed, ${failed} failed -- fixing...`;
      }
      return `All ${passed} tests passed!`;
    }
    default:
      return `Done`;
  }
}

// --- Streaming API call with retry for rate limits ---
async function callAPIStreaming(params) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const stream = client.messages.stream(params);

      // Print text as it arrives — word by word
      stream.on("text", (text) => process.stdout.write(text));

      // Log tool calls with human-readable descriptions
      stream.on("contentBlock", (block) => {
        if (block.type === "tool_use") {
          const label = describeToolCall(block.name, block.input);
          console.log(`\n${label}`);
        }
      });

      // Wait for the full response and return it
      return await stream.finalMessage();
    } catch (err) {
      if (err.status === 429) {
        const waitSec = 30 * (attempt + 1);
        console.log(`\n⏳ Rate limited — waiting ${waitSec}s before retry...\n`);
        await new Promise((r) => setTimeout(r, waitSec * 1000));
      } else {
        throw err;
      }
    }
  }
  throw new Error("Rate limited too many times, giving up.");
}

// --- The agent loop (shared by all modes) ---
// Returns all text Claude produced during the run
async function runAgent(systemPrompt, userMessage, projectPath, { model = "claude-sonnet-4-6", files = null } = {}) {
  // Include a snapshot — targeted if files specified, full otherwise
  const snapshot = snapshotProject(projectPath, files);
  const fullMessage = `${userMessage}\n\nHere is the full project source code:\n${snapshot}`;
  const messages = [{ role: "user", content: fullMessage }];
  const allText = []; // collect all text blocks for saving later

  while (true) {
    const response = await callAPIStreaming({
      model,
      max_tokens: 64000,
      system: systemPrompt,
      tools,
      messages,
    });

    // Collect text from this response
    for (const block of response.content) {
      if (block.type === "text") allText.push(block.text);
    }

    // If the agent is done talking, we're finished
    if (response.stop_reason === "end_turn") {
      console.log("\n"); // newline after streamed text
      break;
    }

    // Otherwise, execute the tool calls and feed results back
    const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");
    messages.push({ role: "assistant", content: response.content });

    const toolResults = toolUseBlocks.map((tool) => {
      const result = executeTool(tool.name, tool.input, projectPath);
      const summary = describeToolResult(tool.name, tool.input, result);
      console.log(`   ${summary}\n`);
      return {
        type: "tool_result",
        tool_use_id: tool.id,
        content: result,
      };
    });

    messages.push({ role: "user", content: toolResults });
  }

  return allText.join("\n");
}

// --- Parse CLI args ---
function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = { mode: null, positional: [], files: null };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--files" && args[i + 1]) {
      parsed.files = args[i + 1].split(",");
      i++; // skip the value
    } else if (!parsed.mode) {
      parsed.mode = args[i];
    } else {
      parsed.positional.push(args[i]);
    }
  }

  return parsed;
}

// --- CLI ---
const args = parseArgs();
const mode = args.mode;

// Resolve project path: CLI arg > config default > hardcoded fallback
const projectPath = args.positional[0] || ".";
const config = loadConfig(projectPath);
const files = args.files || config.files || null;

if (mode === "review") {
  console.log(`\nReviewing tests in: ${projectPath}\n`);
  runAgent(
    SYSTEM_PROMPTS.review,
    `Review the Playwright test suite in this project. The source code and all test files are provided below. Tell me what's good, what's broken, and what's missing.`,
    projectPath,
    { model: config.reviewModel || "claude-haiku-4-5-20251001", files },
  ).then((reviewText) => {
    const date = new Date().toISOString().slice(0, 10);
    const reportPath = path.join(projectPath, `test-review-${date}.md`);
    fs.writeFileSync(reportPath, reviewText);
    console.log(`\n📄 Review saved to: ${reportPath}\n`);
  });

} else if (mode === "generate") {
  const feature = args.positional[0];
  const project = args.positional[1] || ".";
  const genConfig = loadConfig(project);
  const genFiles = args.files || genConfig.files || null;

  if (!feature) {
    console.log('Usage: node qa-agent.js generate "feature description" [project-path]');
    process.exit(1);
  }

  console.log(`\nGenerating tests for: "${feature}"\n`);
  runAgent(
    SYSTEM_PROMPTS.generate,
    `I need Playwright tests for this feature: ${feature}\n\nThe project source code is provided below. Write comprehensive Playwright tests.`,
    project,
    { model: genConfig.model || "claude-sonnet-4-6", files: genFiles },
  );

} else if (mode === "fix") {
  const testFile = args.positional[0];

  if (!testFile) {
    console.log('Usage: node qa-agent.js fix "tests/my-test.spec.ts" [project-path]');
    process.exit(1);
  }

  const project = args.positional[1] || ".";
  const fixConfig = loadConfig(project);

  // Run the failing tests first to capture the error output
  console.log(`\nRunning failing tests: ${testFile}\n`);
  let failureLog;
  try {
    failureLog = execSync(`npx playwright test ${testFile} --reporter=list 2>&1`, {
      cwd: project, timeout: 120000, encoding: "utf-8",
    });
    console.log("All tests passed — nothing to fix!");
    process.exit(0);
  } catch (err) {
    failureLog = err.stdout || err.stderr || err.message;
    console.log("Tests failed. Sending to Claude to fix...\n");
  }

  runAgent(
    SYSTEM_PROMPTS.fix,
    `These Playwright tests are failing. Fix them.\n\nFailing test file: ${testFile}\n\nFailure output:\n${failureLog}`,
    project,
    { model: fixConfig.model || "claude-sonnet-4-6", files: args.files || fixConfig.files },
  );

} else if (mode === "bug") {
  const description = args.positional[0];
  const project = args.positional[1] || ".";
  const bugConfig = loadConfig(project);
  const bugFiles = args.files || bugConfig.files || null;

  if (!description) {
    console.log('Usage: node qa-agent.js bug "description of the bug" [project-path]');
    process.exit(1);
  }

  console.log(`\nAnalyzing bug: "${description}"\n`);
  runAgent(
    SYSTEM_PROMPTS.bug,
    `I found a bug: ${description}\n\nAnalyze the source code provided below, identify the root cause, and write a professional GitHub issue.`,
    project,
    { model: bugConfig.model || "claude-sonnet-4-6", files: bugFiles },
  ).then((issueText) => {
    const date = new Date().toISOString().slice(0, 10);
    const reportPath = path.join(project, `bug-report-${date}.md`);
    fs.writeFileSync(reportPath, issueText);
    console.log(`\n📄 Bug report saved to: ${reportPath}\n`);
  });

} else {
  console.log("QA Agent — generates, reviews, fixes tests, and files bug reports\n");
  console.log("Commands:");
  console.log('  node qa-agent.js generate "feature description" [project-path]');
  console.log("  node qa-agent.js review [project-path]");
  console.log('  node qa-agent.js fix "tests/my-test.spec.ts" [project-path]');
  console.log('  node qa-agent.js bug "bug description" [project-path]');
  console.log("\nOptions:");
  console.log("  --files app/app.js,app/index.html   Only include these files in the snapshot");
  console.log("\nConfig: add a .qa-agent.json to your project:");
  console.log('  { "model": "claude-sonnet-4-6", "reviewModel": "claude-haiku-4-5-20251001", "files": ["app/app.js", "app/index.html"] }');
  process.exit(1);
}
