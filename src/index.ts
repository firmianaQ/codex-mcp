#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { CodexAppServerClient } from "./codex-client.js";

const client = new CodexAppServerClient();

function wrapTool<TArgs>(fn: (args: TArgs) => Promise<unknown>) {
  return async (args: TArgs) => {
    try {
      const data = await fn(args);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: message }],
        isError: true,
      };
    }
  };
}

function createServer(): McpServer {
  const server = new McpServer(
    { name: "codex-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.registerTool(
    "codex_models",
    {
      description:
        "List available Codex models along with supported reasoning effort levels and service tiers.",
      inputSchema: z.object({}),
    },
    wrapTool(() => client.listModels())
  );

  server.registerTool(
    "codex_run",
    {
      description:
        "Start a new Codex thread or continue an existing threadId, dynamically configuring model, effort, sandbox, and cwd. Waits up to waitSeconds before returning progress or final output.",
      inputSchema: z.object({
        prompt: z.string().min(1).describe("Task instructions for Codex."),
        cwd: z.string().optional().describe("Working directory path for the thread."),
        model: z.string().optional().describe("Model ID (e.g., gpt-6.2-sol, gpt-6.2-astra)."),
        effort: z
          .string()
          .optional()
          .describe("Reasoning effort (e.g., low, medium, high, xhigh, max, ultra)."),
        serviceTier: z.string().optional().describe("Optional service tier (e.g., priority)."),
        sandbox: z
          .enum(["read-only", "workspace-write", "danger-full-access"])
          .optional()
          .describe("Sandbox policy for new threads. Defaults to workspace-write."),
        approvalPolicy: z
          .enum(["untrusted", "on-request", "never"])
          .optional()
          .describe("Approval policy for commands/edits. Defaults to never."),
        threadId: z.string().optional().describe("Existing threadId to continue."),
        ephemeral: z.boolean().optional().describe("Do not persist session files to disk."),
        outputSchema: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Optional JSON Schema constraining Codex's final message."),
        waitSeconds: z
          .number()
          .optional()
          .describe("Seconds to wait for completion before returning (0..180, default 30)."),
      }),
    },
    wrapTool((args) => client.run(args))
  );

  server.registerTool(
    "codex_review",
    {
      description:
        "Run a read-only Codex code review on uncommitted changes, a branch, commit, or custom target.",
      inputSchema: z.object({
        cwd: z.string().optional().describe("Repository working directory."),
        target: z
          .enum(["uncommittedChanges", "baseBranch", "commit", "custom"])
          .optional()
          .describe("Review target type. Defaults to uncommittedChanges."),
        targetValue: z
          .string()
          .optional()
          .describe("Branch name (for baseBranch) or commit SHA (for commit)."),
        instructions: z
          .string()
          .optional()
          .describe("Custom review instructions (for custom target)."),
        model: z.string().optional().describe("Optional model ID override."),
        effort: z.string().optional().describe("Optional reasoning effort override."),
        threadId: z.string().optional().describe("Optional existing threadId."),
        waitSeconds: z
          .number()
          .optional()
          .describe("Seconds to wait for completion (0..180, default 30)."),
      }),
    },
    wrapTool((args) => client.review(args))
  );

  server.registerTool(
    "codex_wait",
    {
      description:
        "Wait/poll for an active Codex threadId to make progress, complete, or surface pending requests.",
      inputSchema: z.object({
        threadId: z.string().min(1).describe("Thread ID returned by codex_run or codex_review."),
        waitSeconds: z
          .number()
          .optional()
          .describe("Seconds to wait before returning current snapshot (0..180, default 30)."),
      }),
    },
    wrapTool((args) => client.wait(args))
  );

  server.registerTool(
    "codex_control",
    {
      description:
        "Steer an in-flight Codex turn, interrupt it, or respond to a pending server request (requestId).",
      inputSchema: z.object({
        action: z.enum(["steer", "interrupt", "respond"]).describe("Control action to perform."),
        threadId: z.string().optional().describe("Target threadId (for steer / interrupt)."),
        turnId: z
          .string()
          .optional()
          .describe("Optional turnId override (defaults to active turn)."),
        prompt: z.string().optional().describe("Follow-up steering instructions (for steer)."),
        requestId: z.string().optional().describe("Pending requestId to answer (for respond)."),
        response: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("JSON result payload for the pending request (e.g., { decision: 'accept' })."),
      }),
    },
    wrapTool((args) => client.control(args))
  );

  return server;
}

const handle = serveStdio(createServer, {
  onerror: (err) => console.error("[codex-mcp]", err),
});

let shuttingDown = false;
async function shutdown(code = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await handle.close();
  } catch {}
  await client.close();
  process.exit(code);
}

process.stdin.on("end", () => void shutdown(0));
process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));
