---
name: codex-dispatch
description: >-
  Use this skill when the user asks to dispatch coding execution, refactoring, or code review tasks
  to OpenAI Codex via the `codex-mcp` MCP server (including shorthand such as "派发 codex",
  "gpt6.2sol", "gpt6.2astra", or "让 codex 执行/review").
---

# Codex Dispatch Workflow (`codex-mcp`)

Coordinate planning/verification in Antigravity with execution/review in Codex via `codex-mcp` tools (`codex_models`, `codex_run`, `codex_review`, `codex_wait`, `codex_control`).

## 1. Model & Effort Confirmation (Required)

- If the user did **not** specify a Codex model, **ask which model (and reasoning effort) to use before dispatching**. Do not silently pick a model on their behalf.
- Offer concise choices via `ask_question` when available (call `codex_models` first if the live list is unknown; common options: `gpt-6.2-sol`, `gpt-6.2-astra` with effort `medium` / `high` / `xhigh`).
- Normalize shorthand aliases to exact model IDs (e.g. `gpt6.2sol` -> `gpt-6.2-sol`, `gpt6.2astra` -> `gpt-6.2-astra`). If an alias is ambiguous, check `codex_models` first.

## 2. Sync vs. Async Execution Mode

- **Default: Sync direct call** — For single tasks, routine code reviews, or edits that need immediate verification next, call `codex_run` or `codex_review` directly in the main session (`waitSeconds: 30`–`120`, up to `180` for heavier turns) and follow up with `codex_wait` while `status === "running"`.
- **Switch to Async Subagent** — When the user asks for background/async execution, requests parallel Codex tasks, or dispatches a long-running high-effort task (`xhigh` / `max` / `ultra`) while continuing other work in the main session:
  1. Use `define_subagent` (with `EnableMCPTools: true`) and `invoke_subagent` (`Model: "flash"`) to delegate calling `codex_run` / `codex_review` and polling `codex_wait`.
  2. After `invoke_subagent`, end the main turn and wait passively for the subagent's wakeup message instead of polling with `schedule`. Require the subagent to return `threadId`, `status`, `filesChanged`, `commands`, `reply`, `pendingRequests`, and `error` when done or blocked.
  3. Never run two `workspace-write` tasks concurrently on the same `cwd`; isolate concurrent writers with separate directories or `git worktree`.

## 3. Prompt & Rule Forwarding

- Always pass an explicit `cwd` matching the target repository.
- Codex automatically loads `AGENTS.md` and `.agents/skills/*/SKILL.md`, but **does not** load `GEMINI.md`, `.agents/rules/`, or `~/.gemini/config/`. Whenever those Antigravity-only rules impose relevant constraints (architecture invariants, branching rules, coding standards, scope limits, verification SOPs/commands), summarize them directly in the dispatched `prompt` along with clear acceptance criteria.

## 4. Safety, Review & Iteration

- **Review**: Always use `codex_review` (enforces `read-only` sandbox; supports `uncommittedChanges`, `baseBranch`, `commit`, `custom`).
- **Execution**: Use `codex_run` (`sandbox: "workspace-write"` for edits, `"read-only"` for analysis).
- **Pending Requests**: If `status === "awaiting_response"`, stop and report `pendingRequests` to the user for a decision; only call `codex_control` (`action: "respond"`) after user approval.
- **Verification & Rework**: Never treat Codex's self-reported completion as final proof. Inspect reported `filesChanged` / diffs and run the repository's local verification SOP or test commands after Codex edits; in your summary, distinguish Codex review/run output from locally executed verification. For follow-up fixes, continue the same `threadId` via `codex_run`; to redirect or stop an in-flight turn, use `codex_control` (`action: "steer"` or `"interrupt"`).
