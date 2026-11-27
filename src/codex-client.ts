import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";

const DEFAULT_WAIT_SECONDS = 30;
const MAX_WAIT_SECONDS = 180;
const MAX_COMMANDS = 30;

export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type ApprovalPolicy = "untrusted" | "on-request" | "never";
export type ReviewTargetType = "uncommittedChanges" | "baseBranch" | "commit" | "custom";
export type ControlAction = "steer" | "interrupt" | "respond";

export interface RunOptions {
  prompt: string;
  cwd?: string;
  model?: string;
  effort?: string;
  serviceTier?: string;
  sandbox?: SandboxMode;
  approvalPolicy?: ApprovalPolicy;
  threadId?: string;
  ephemeral?: boolean;
  outputSchema?: Record<string, unknown>;
  waitSeconds?: number;
}

export interface ReviewOptions {
  cwd?: string;
  target?: ReviewTargetType;
  targetValue?: string;
  instructions?: string;
  model?: string;
  effort?: string;
  threadId?: string;
  waitSeconds?: number;
}

export interface WaitOptions {
  threadId: string;
  waitSeconds?: number;
}

export interface ControlOptions {
  action: ControlAction;
  threadId?: string;
  turnId?: string;
  prompt?: string;
  requestId?: string;
  response?: Record<string, unknown>;
}

export interface ModelSummary {
  id: string;
  displayName: string;
  isDefault: boolean;
  defaultReasoningEffort: string | null;
  supportedReasoningEfforts: string[];
  serviceTiers: string[];
}

export interface CommandSummary {
  command: string;
  exitCode: number | null;
  status: string | null;
}

export interface PendingRequestView {
  requestId: string;
  method: string;
  params: unknown;
}

export interface ThreadSnapshot {
  threadId: string;
  turnId: string | null;
  model: string | null;
  cwd: string | null;
  sandbox: unknown;
  status: string;
  reply: string;
  filesChanged: string[];
  commands: CommandSummary[];
  pendingRequests: PendingRequestView[];
  error: unknown;
}

interface PendingRpcWaiter {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  method: string;
}

interface ServerRequestEntry {
  id: string | number;
  method: string;
  params: Record<string, unknown> | undefined;
  threadId: string;
}

interface ThreadState {
  threadId: string;
  model: string | null;
  cwd: string | null;
  sandbox: unknown;
  activeTurnId: string | null;
  status: string;
  text: string;
  finalText: string;
  filesChanged: Set<string>;
  commands: CommandSummary[];
  error: unknown;
  pendingRequests: Map<string, ServerRequestEntry>;
  waiters: Set<() => void>;
}

interface RpcWireMessage {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

function clampWaitSeconds(value: number | undefined): number {
  if (typeof value !== "number" || Number.isNaN(value)) return DEFAULT_WAIT_SECONDS;
  return Math.max(0, Math.min(MAX_WAIT_SECONDS, value));
}

function killProcessTree(child: ChildProcessWithoutNullStreams | null): Promise<void> {
  const pid = child?.pid;
  if (!pid) return Promise.resolve();
  if (process.platform !== "win32") {
    try {
      child.kill("SIGTERM");
    } catch {}
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      try {
        killer.kill();
      } catch {}
      resolve();
    }, 3000);
    killer.on("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    killer.on("error", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function extractLastAgentMessage(items: unknown): string {
  if (!Array.isArray(items)) return "";
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i] as { type?: string; text?: unknown } | undefined;
    if (item?.type === "agentMessage" && typeof item.text === "string") {
      return item.text;
    }
  }
  return "";
}

/**
 * Manages a long-lived `codex app-server` child process and tracks per-thread
 * turn progress, outputs, and server-initiated approval/input requests.
 */
export class CodexAppServerClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private rlOut: readline.Interface | null = null;
  private rlErr: readline.Interface | null = null;
  private startPromise: Promise<void> | null = null;
  private nextId = 1;
  private pendingRpc = new Map<number, PendingRpcWaiter>();
  private threads = new Map<string, ThreadState>();
  private pendingServerRequests = new Map<string, ServerRequestEntry>();
  private closing = false;

  async ensureStarted(): Promise<void> {
    if (this.child && !this.child.killed && this.child.exitCode === null) {
      return this.startPromise ?? Promise.resolve();
    }
    if (this.startPromise) return this.startPromise;

    this.closing = false;
    this.startPromise = this.#spawnAndInitialize().catch((err) => {
      this.startPromise = null;
      throw err;
    });
    return this.startPromise;
  }

  async #spawnAndInitialize(): Promise<void> {
    const bin = process.env.CODEX_BIN || (process.platform === "win32" ? "codex.cmd" : "codex");
    const child =
      process.platform === "win32"
        ? spawn("cmd.exe", ["/d", "/c", bin, "app-server", "--listen", "stdio://"], {
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
          })
        : spawn(bin, ["app-server", "--listen", "stdio://"], {
            stdio: ["pipe", "pipe", "pipe"],
          });

    this.child = child;
    const stderrTail: string[] = [];

    this.rlErr = readline.createInterface({ input: child.stderr });
    this.rlErr.on("line", (line) => {
      if (stderrTail.length >= 20) stderrTail.shift();
      stderrTail.push(line);
      process.stderr.write(`[codex-app-server] ${line}\n`);
    });

    this.rlOut = readline.createInterface({ input: child.stdout });
    this.rlOut.on("line", (line) => this.#handleLine(line));

    child.on("exit", (code, signal) => {
      const reason = `codex app-server exited (code=${code}, signal=${signal})${
        stderrTail.length ? `: ${stderrTail.join(" | ")}` : ""
      }`;
      for (const [, waiter] of this.pendingRpc) {
        waiter.reject(new Error(reason));
      }
      this.pendingRpc.clear();
      this.pendingServerRequests.clear();

      for (const state of this.threads.values()) {
        if (state.status === "running" || state.status === "awaiting_response") {
          state.status = "failed";
          state.error = { message: reason };
          state.activeTurnId = null;
          this.#wakeWaiters(state);
        }
      }
      this.child = null;
      this.startPromise = null;
    });

    await this.#request("initialize", {
      clientInfo: { name: "codex-mcp", version: "0.1.0" },
      capabilities: null,
    });
    this.#send({ method: "initialized" });
  }

  #send(msg: Record<string, unknown>): void {
    if (!this.child?.stdin?.writable) {
      throw new Error("codex app-server stdin is not writable");
    }
    this.child.stdin.write(JSON.stringify(msg) + "\n");
  }

  #request<T = Record<string, unknown>>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pendingRpc.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        method,
      });
      try {
        this.#send({ id, method, params });
      } catch (err) {
        this.pendingRpc.delete(id);
        reject(err);
      }
    });
  }

  #getOrCreateThreadState(threadId: string): ThreadState {
    let state = this.threads.get(threadId);
    if (!state) {
      state = {
        threadId,
        model: null,
        cwd: null,
        sandbox: null,
        activeTurnId: null,
        status: "idle",
        text: "",
        finalText: "",
        filesChanged: new Set<string>(),
        commands: [],
        error: null,
        pendingRequests: new Map<string, ServerRequestEntry>(),
        waiters: new Set<() => void>(),
      };
      this.threads.set(threadId, state);
    }
    return state;
  }

  #resetTurnBuffers(state: ThreadState): void {
    state.status = "running";
    state.activeTurnId = null;
    state.text = "";
    state.finalText = "";
    state.filesChanged.clear();
    state.commands = [];
    state.error = null;
  }

  #wakeWaiters(state: ThreadState): void {
    for (const wake of state.waiters) wake();
  }

  #handleLine(line: string): void {
    if (!line.trim()) return;
    let msg: RpcWireMessage;
    try {
      msg = JSON.parse(line) as RpcWireMessage;
    } catch {
      return;
    }

    // Response to our RPC request
    if (msg.id !== undefined && msg.method === undefined) {
      const waiter = typeof msg.id === "number" ? this.pendingRpc.get(msg.id) : undefined;
      if (waiter && typeof msg.id === "number") {
        this.pendingRpc.delete(msg.id);
        if (msg.error) {
          waiter.reject(new Error(`${waiter.method}: ${JSON.stringify(msg.error)}`));
        } else {
          waiter.resolve(msg.result);
        }
      }
      return;
    }

    // Server-initiated request (requires a response with matching id)
    if (msg.id !== undefined && msg.method !== undefined) {
      const key = String(msg.id);
      const threadId = typeof msg.params?.threadId === "string" ? msg.params.threadId : "_global";
      const entry: ServerRequestEntry = {
        id: msg.id,
        method: msg.method,
        params: msg.params,
        threadId,
      };
      this.pendingServerRequests.set(key, entry);
      const state = this.#getOrCreateThreadState(threadId);
      state.pendingRequests.set(key, entry);
      state.status = "awaiting_response";
      this.#wakeWaiters(state);
      return;
    }

    // Server notification
    if (msg.method) {
      this.#handleNotification(msg.method, msg.params);
    }
  }

  #handleNotification(method: string, params: Record<string, unknown> | undefined): void {
    const threadId = typeof params?.threadId === "string" ? params.threadId : undefined;
    if (!threadId || !params) return;
    const state = this.#getOrCreateThreadState(threadId);

    switch (method) {
      case "turn/started": {
        const turn = params.turn as { id?: string } | undefined;
        state.activeTurnId = turn?.id ?? state.activeTurnId;
        state.status = "running";
        break;
      }
      case "item/agentMessage/delta":
        if (typeof params.delta === "string") {
          state.text += params.delta;
        }
        break;
      case "item/completed": {
        const item = params.item as
          | {
              type?: string;
              text?: unknown;
              changes?: Array<{ path?: string }>;
              command?: string;
              exitCode?: number | null;
              status?: string | null;
            }
          | undefined;
        if (!item) break;
        if (item.type === "agentMessage" && typeof item.text === "string") {
          state.finalText = item.text;
        } else if (item.type === "fileChange" && Array.isArray(item.changes)) {
          for (const change of item.changes) {
            if (change?.path) state.filesChanged.add(change.path);
          }
        } else if (item.type === "commandExecution" && typeof item.command === "string") {
          if (state.commands.length >= MAX_COMMANDS) state.commands.shift();
          state.commands.push({
            command: item.command,
            exitCode: item.exitCode ?? null,
            status: item.status ?? null,
          });
        }
        break;
      }
      case "turn/completed": {
        const turn = params.turn as
          | { items?: unknown; status?: string; error?: unknown }
          | undefined;
        const extracted = extractLastAgentMessage(turn?.items);
        if (extracted) state.finalText = extracted;
        state.status = turn?.status ?? "completed";
        state.error = turn?.error ?? null;
        state.activeTurnId = null;
        this.#wakeWaiters(state);
        break;
      }
      case "error":
        if (params.willRetry === false) {
          state.error = params.error ?? params;
          state.status = "failed";
          state.activeTurnId = null;
          this.#wakeWaiters(state);
        }
        break;
      default:
        break;
    }
  }

  #snapshot(state: ThreadState): ThreadSnapshot {
    return {
      threadId: state.threadId,
      turnId: state.activeTurnId,
      model: state.model,
      cwd: state.cwd,
      sandbox: state.sandbox,
      status: state.status,
      reply: state.finalText || state.text,
      filesChanged: Array.from(state.filesChanged),
      commands: state.commands,
      pendingRequests: Array.from(state.pendingRequests.values()).map((r) => ({
        requestId: String(r.id),
        method: r.method,
        params: r.params,
      })),
      error: state.error,
    };
  }

  async #waitForState(state: ThreadState, waitSeconds?: number): Promise<ThreadSnapshot> {
    const secs = clampWaitSeconds(waitSeconds);
    if (secs === 0 || state.status !== "running" || state.pendingRequests.size > 0) {
      return this.#snapshot(state);
    }

    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        state.waiters.delete(onWake);
        resolve();
      };
      const onWake = () => {
        if (state.status !== "running" || state.pendingRequests.size > 0) {
          done();
        }
      };
      const timer = setTimeout(done, secs * 1000);
      state.waiters.add(onWake);
    });

    return this.#snapshot(state);
  }

  async #ensureThread(opts: {
    threadId?: string;
    cwd?: string;
    model?: string;
    sandbox?: SandboxMode;
    approvalPolicy?: ApprovalPolicy;
    ephemeral?: boolean;
    config?: Record<string, unknown>;
  }): Promise<ThreadState> {
    const { threadId, cwd, model, sandbox, approvalPolicy, ephemeral, config } = opts;

    if (!threadId) {
      const res = await this.#request<{
        thread: { id: string };
        model?: string;
        cwd?: string;
        sandbox?: unknown;
      }>("thread/start", {
        ...(cwd ? { cwd } : {}),
        ...(model ? { model } : {}),
        sandbox: sandbox ?? "workspace-write",
        approvalPolicy: approvalPolicy ?? "never",
        ...(ephemeral !== undefined ? { ephemeral } : {}),
        ...(config ? { config } : {}),
      });
      const state = this.#getOrCreateThreadState(res.thread.id);
      state.model = res.model ?? model ?? null;
      state.cwd = res.cwd ?? cwd ?? null;
      state.sandbox = res.sandbox ?? sandbox ?? null;
      return state;
    }

    if (!this.threads.has(threadId)) {
      const res = await this.#request<{
        thread?: { id?: string };
        model?: string;
        cwd?: string;
        sandbox?: unknown;
      }>("thread/resume", {
        threadId,
        ...(cwd ? { cwd } : {}),
        ...(model ? { model } : {}),
        ...(sandbox ? { sandbox } : {}),
        ...(approvalPolicy ? { approvalPolicy } : {}),
        ...(config ? { config } : {}),
        excludeTurns: true,
      });
      const state = this.#getOrCreateThreadState(res.thread?.id || threadId);
      state.model = res.model ?? model ?? null;
      state.cwd = res.cwd ?? cwd ?? null;
      state.sandbox = res.sandbox ?? sandbox ?? null;
      return state;
    }

    const state = this.threads.get(threadId)!;
    if (model) state.model = model;
    if (cwd) state.cwd = cwd;
    return state;
  }

  async listModels(): Promise<{ models: ModelSummary[] }> {
    await this.ensureStarted();
    const res = await this.#request<{
      data?: Array<{
        id: string;
        displayName: string;
        isDefault?: boolean;
        defaultReasoningEffort?: string | null;
        supportedReasoningEfforts?: Array<{ reasoningEffort: string }>;
        serviceTiers?: Array<{ id: string }>;
      }>;
    }>("model/list", {});
    return {
      models: (res.data || []).map((m) => ({
        id: m.id,
        displayName: m.displayName,
        isDefault: Boolean(m.isDefault),
        defaultReasoningEffort: m.defaultReasoningEffort ?? null,
        supportedReasoningEfforts: (m.supportedReasoningEfforts || []).map(
          (e) => e.reasoningEffort
        ),
        serviceTiers: (m.serviceTiers || []).map((t) => t.id),
      })),
    };
  }

  async run(opts: RunOptions): Promise<ThreadSnapshot> {
    const {
      prompt,
      cwd,
      model,
      effort,
      serviceTier,
      sandbox,
      approvalPolicy,
      threadId,
      ephemeral,
      outputSchema,
      waitSeconds,
    } = opts;

    if (typeof prompt !== "string" || !prompt.trim()) {
      throw new Error("prompt is required and must be a non-empty string");
    }
    await this.ensureStarted();

    const state = await this.#ensureThread({
      threadId,
      cwd,
      model,
      sandbox,
      approvalPolicy,
      ephemeral,
    });

    // Reset turn state before turn/start so fast turn/completed notifications cannot race behind it.
    this.#resetTurnBuffers(state);

    const turnRes = await this.#request<{ turn?: { id?: string } }>("turn/start", {
      threadId: state.threadId,
      input: [{ type: "text", text: prompt, text_elements: [] }],
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(serviceTier ? { serviceTier } : {}),
      ...(cwd ? { cwd } : {}),
      ...(approvalPolicy ? { approvalPolicy } : {}),
      ...(outputSchema ? { outputSchema } : {}),
    });

    if (state.status === "running" && turnRes?.turn?.id) {
      state.activeTurnId = turnRes.turn.id;
    }

    return this.#waitForState(state, waitSeconds);
  }

  async review(opts: ReviewOptions): Promise<ThreadSnapshot> {
    const {
      cwd,
      target = "uncommittedChanges",
      targetValue,
      instructions,
      model,
      effort,
      threadId,
      waitSeconds,
    } = opts;

    let reviewTarget: Record<string, unknown>;
    switch (target) {
      case "uncommittedChanges":
        reviewTarget = { type: "uncommittedChanges" };
        break;
      case "baseBranch":
        if (!targetValue) throw new Error("targetValue (branch name) is required for baseBranch");
        reviewTarget = { type: "baseBranch", branch: targetValue };
        break;
      case "commit":
        if (!targetValue) throw new Error("targetValue (commit sha) is required for commit");
        reviewTarget = { type: "commit", sha: targetValue, title: null };
        break;
      case "custom": {
        const text = instructions || targetValue;
        if (!text) throw new Error("instructions or targetValue is required for custom review");
        reviewTarget = { type: "custom", instructions: text };
        break;
      }
      default:
        throw new Error(`Unsupported review target: ${String(target)}`);
    }

    await this.ensureStarted();

    const state = await this.#ensureThread({
      threadId,
      cwd,
      model,
      sandbox: "read-only",
      approvalPolicy: "never",
      config: effort ? { model_reasoning_effort: effort } : undefined,
    });

    this.#resetTurnBuffers(state);

    const revRes = await this.#request<{ turn?: { id?: string } }>("review/start", {
      threadId: state.threadId,
      target: reviewTarget,
      delivery: "inline",
    });

    if (state.status === "running" && revRes?.turn?.id) {
      state.activeTurnId = revRes.turn.id;
    }

    return this.#waitForState(state, waitSeconds);
  }

  async wait({ threadId, waitSeconds }: WaitOptions): Promise<ThreadSnapshot> {
    if (!threadId) throw new Error("threadId is required");
    const state = this.threads.get(threadId);
    if (!state) {
      throw new Error(`Unknown threadId in current session: ${threadId}`);
    }
    return this.#waitForState(state, waitSeconds);
  }

  async control(opts: ControlOptions): Promise<Record<string, unknown>> {
    const { action, threadId, prompt, turnId, requestId, response } = opts;
    await this.ensureStarted();

    switch (action) {
      case "steer": {
        if (!threadId) throw new Error("threadId is required for steer");
        if (typeof prompt !== "string" || !prompt.trim()) {
          throw new Error("prompt is required for steer");
        }
        const state = this.threads.get(threadId);
        const expectedTurnId = turnId || state?.activeTurnId;
        if (!expectedTurnId) {
          throw new Error("turnId could not be resolved; provide turnId or steer an active turn");
        }
        return this.#request("turn/steer", {
          threadId,
          expectedTurnId,
          input: [{ type: "text", text: prompt, text_elements: [] }],
        });
      }
      case "interrupt": {
        if (!threadId) throw new Error("threadId is required for interrupt");
        const state = this.threads.get(threadId);
        const resolvedTurnId = turnId || state?.activeTurnId;
        if (!resolvedTurnId) {
          throw new Error("turnId could not be resolved; provide turnId or interrupt an active turn");
        }
        return this.#request("turn/interrupt", {
          threadId,
          turnId: resolvedTurnId,
        });
      }
      case "respond": {
        if (requestId === undefined || requestId === null || requestId === "") {
          throw new Error("requestId is required for respond");
        }
        if (response === undefined) {
          throw new Error("response payload is required for respond");
        }
        const key = String(requestId);
        const entry = this.pendingServerRequests.get(key);
        if (!entry) {
          throw new Error(`No pending server request with requestId=${key}`);
        }
        this.#send({ id: entry.id, result: response });
        this.pendingServerRequests.delete(key);
        const state = this.threads.get(entry.threadId);
        if (state) {
          state.pendingRequests.delete(key);
          if (state.pendingRequests.size === 0 && state.activeTurnId) {
            state.status = "running";
          }
          this.#wakeWaiters(state);
        }
        return { ok: true, requestId: key, method: entry.method };
      }
      default:
        throw new Error(`Unsupported control action: ${String(action)}`);
    }
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    const child = this.child;
    this.child = null;
    this.startPromise = null;
    try {
      this.rlOut?.close();
    } catch {}
    try {
      this.rlErr?.close();
    } catch {}
    try {
      child?.stdin?.end();
    } catch {}
    await killProcessTree(child);
  }
}
