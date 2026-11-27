import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import readline from "node:readline";

const TIMEOUT_MS = 40_000;

function killTree(child) {
  if (!child?.pid) return Promise.resolve();
  if (process.platform !== "win32") {
    try {
      child.kill("SIGTERM");
    } catch {}
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    const t = setTimeout(() => {
      try {
        killer.kill();
      } catch {}
      resolve();
    }, 3000);
    killer.on("exit", () => {
      clearTimeout(t);
      resolve();
    });
    killer.on("error", () => {
      clearTimeout(t);
      resolve();
    });
  });
}

async function main() {
  const child = spawn("node", ["dist/index.js"], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  const stderrLines = [];
  const rlErr = readline.createInterface({ input: child.stderr });
  rlErr.on("line", (line) => stderrLines.push(line));

  const pending = new Map();
  const rlOut = readline.createInterface({ input: child.stdout });
  rlOut.on("line", (line) => {
    if (!line.trim()) return;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) {
      const waiter = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(JSON.stringify(msg.error)));
      else waiter.resolve(msg.result);
    }
  });

  const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
  const request = (id, method, params) =>
    new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      send({ jsonrpc: "2.0", id, method, params });
    });

  const timeoutPromise = new Promise((_, reject) => {
    const t = setTimeout(() => {
      reject(new Error(`Smoke test timed out after ${TIMEOUT_MS}ms. stderr=${stderrLines.join(" | ")}`));
    }, TIMEOUT_MS);
    t.unref?.();
  });

  try {
    const runTest = async () => {
      const init = await request(1, "initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "smoke-test", version: "0.1.0" },
      });
      assert.equal(init.serverInfo?.name, "codex-mcp");

      send({ jsonrpc: "2.0", method: "notifications/initialized" });

      const listed = await request(2, "tools/list", {});
      const toolNames = listed.tools.map((t) => t.name);
      for (const name of ["codex_models", "codex_run", "codex_review", "codex_wait", "codex_control"]) {
        assert.ok(toolNames.includes(name), `Missing tool: ${name}`);
      }

      // Verify Zod input validation rejects missing required prompt
      let validationRejected = false;
      try {
        const badRes = await request(201, "tools/call", {
          name: "codex_run",
          arguments: {},
        });
        validationRejected = Boolean(badRes?.isError);
      } catch {
        validationRejected = true;
      }
      assert.ok(validationRejected, "Expected codex_run({}) to fail Zod schema validation");

      const modelsRes = await request(3, "tools/call", {
        name: "codex_models",
        arguments: {},
      });
      assert.ok(!modelsRes.isError, `codex_models failed: ${modelsRes.content?.[0]?.text}`);
      const modelsData = JSON.parse(modelsRes.content[0].text);
      const sol = modelsData.models.find((m) => m.id === "gpt-6.2-sol");
      assert.ok(sol, "Expected gpt-6.2-sol in codex_models output");
      assert.ok(sol.supportedReasoningEfforts.includes("xhigh"), "Expected xhigh effort for gpt-6.2-sol");

      const runRes = await request(4, "tools/call", {
        name: "codex_run",
        arguments: {
          prompt: "Reply with exactly: OK",
          cwd: process.cwd(),
          model: "gpt-6.2-sol",
          effort: "low",
          sandbox: "read-only",
          approvalPolicy: "never",
          ephemeral: true,
          waitSeconds: 25,
        },
      });
      assert.ok(!runRes.isError, `codex_run failed: ${runRes.content?.[0]?.text}`);
      const runData = JSON.parse(runRes.content[0].text);
      assert.equal(runData.status, "completed");
      assert.equal(runData.reply.trim(), "OK");

      const exitCode = await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("Server did not exit within 5s after stdin close")), 5000);
        child.once("exit", (code) => {
          clearTimeout(t);
          resolve(code);
        });
        child.stdin.end();
      });
      assert.equal(exitCode, 0, `Expected exit code 0, got ${exitCode}`);

      console.log(
        JSON.stringify(
          {
            ok: true,
            tools: toolNames,
            modelsCount: modelsData.models.length,
            threadId: runData.threadId,
            reply: runData.reply,
          },
          null,
          2
        )
      );
    };

    await Promise.race([runTest(), timeoutPromise]);
  } finally {
    rlOut.close();
    rlErr.close();
    await killTree(child);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
