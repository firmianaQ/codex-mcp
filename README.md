# codex-mcp

> **Early / Experimental (`v0.1.0`)**: Minimal TypeScript MCP (`stdio`) bridge to the local OpenAI `codex app-server` (`codex-cli >= 0.172.0`), built with `@modelcontextprotocol/server` (v2) and `zod`.

## Prerequisites

- Node.js 18+ (tested on Node v22.19.0)
- `codex` CLI installed and authenticated (`codex login` / `~/.codex`)

## Build

```bash
npm install
npm run build
```

## Tools

| Tool | Description |
| :--- | :--- |
| `codex_models` | List available Codex models and their supported `effort` / `serviceTier` values. |
| `codex_run` | Start or continue a Codex thread (`threadId`), dynamically setting `model`, `effort`, `serviceTier`, `sandbox`, `approvalPolicy`, `cwd`, and `waitSeconds`. |
| `codex_review` | Run a `read-only` code review (`uncommittedChanges`, `baseBranch`, `commit`, or `custom`). |
| `codex_wait` | Wait/poll for an active thread (`threadId`) to progress, finish, or emit pending approval requests. |
| `codex_control` | `steer` an active turn, `interrupt` it, or `respond` to a pending server request (`requestId`). |

## MCP Configuration

Example `~/.gemini/config/mcp_config.json` (Antigravity) or any MCP stdio client:

```json
{
  "mcpServers": {
    "codex-mcp": {
      "command": "node",
      "args": ["/path/to/codex-mcp/dist/index.js"]
    }
  }
}
```

## Optional Antigravity Skill

A ready-to-use dispatch skill is included at `skills/codex-dispatch/SKILL.md`. Copy it to `~/.gemini/config/skills/codex-dispatch/SKILL.md` to standardize model confirmation, sync/async subagent dispatch, and read-only review guardrails.

## Smoke Test

```bash
npm run typecheck
npm test
```
