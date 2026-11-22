import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createCodexInferenceProxy } from "./app-server/inference-proxy.js";
import type { NativeModelSource } from "./app-server/native-subagent-monitor-types.js";
import {
  createTechnicalContinuation,
  type Checkpoint,
  type ContinuationStore,
} from "./app-server/technical-continuation.js";

const transport = vi.hoisted(() => ({
  respond: async (_signal?: AbortSignal) => new Response("unconfigured", { status: 500 }),
}));
// The provider I/O is a mock. The actual loopback HTTP server, request preparation,
// response buffering, error classification and coordinator are not mocked.
vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  isBlockedHostnameOrIp: (hostname: string) => hostname !== "api.openai.com",
  resolvePinnedHostnameWithPolicy: () => {
    throw new Error("WebSocket not in HTTP proof");
  },
  fetchWithSsrFGuard: async (params: {
    url: string;
    beforeRequest?: () => void;
    signal: AbortSignal;
  }) => {
    expect(new URL(params.url).origin).toBe("https://api.openai.com");
    params.beforeRequest?.();
    params.signal.throwIfAborted();
    return { response: await transport.respond(params.signal), release: async () => {} };
  },
}));

async function scenario(code: string, missingResult = false, abortPrimary?: () => void) {
  const directory = await mkdtemp(join(tmpdir(), "continuation-http-"));
  const marker = join(directory, "marker");
  let writes = 0;
  const executeMarker = async () => {
    writes++;
    await writeFile(marker, "one durable effect", { flag: "wx" });
    return readFile(marker, "utf8");
  };
  const output = await executeMarker();
  let primary = 0;
  let fallback = 0;
  const rows = new Map<string, { revision: number; value: Checkpoint }>();
  const store: ContinuationStore = {
    async observe(key) {
      const row = rows.get(key);
      return { value: row && structuredClone(row.value), comparison: String(row?.revision ?? 0) };
    },
    async compareAndApply(key, comparison, intent) {
      const row = rows.get(key);
      if (String(row?.revision ?? 0) !== comparison) return { status: "conflict" };
      rows.set(key, { revision: (row?.revision ?? 0) + 1, value: structuredClone(intent.value) });
      return { status: "applied" };
    },
  };
  const source = {
    assertCurrent() {},
    release() {},
    async completeModelRequest(req) {
      fallback++;
      await req.reserveBudget(0.01);
      expect(req.context.messages).toContainEqual(
        expect.objectContaining({
          role: "toolResult",
          toolCallId: "marker",
          content: [{ type: "text", text: output }],
        }),
      );
      return {
        role: "assistant",
        content: [{ type: "text", text: "continued" }],
        provider: "moonshot",
        model: "kimi-fixture",
        api: "openai-completions",
        stopReason: "stop",
        timestamp: 0,
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
    },
  } satisfies NativeModelSource;
  const continueRequest = createTechnicalContinuation({
    scope: {
      agentId: "crypta",
      sessionId: "synthetic",
      runId: "run",
      observeDeliveries: async () => ({ source: "missing" as const, terminal: "missing" as const }),
      logicalTurnId: () => "logical",
      config: { enabled: true, fallbackModel: "moonshot/kimi-fixture", maxTransientRetries: 0 },
    },
    source,
    store,
    turnId: "turn",
    reserveBudget: async () => {},
  });
  transport.respond = async (signal) => {
    primary++;
    if (abortPrimary) {
      abortPrimary();
      expect(signal?.aborted).toBe(true);
    }
    return new Response(JSON.stringify({ error: { code, type: code } }), { status: 503 });
  };
  const proxy = await createCodexInferenceProxy({
    upstream: new URL("https://api.openai.com/v1"),
    assertCurrent() {},
    bindModelExecution: () => ({ assertCurrent() {}, release() {}, continueRequest }),
  });
  const registration = await proxy.context.register({
    threadId: "synthetic",
    text: "",
    signal: new AbortController().signal,
    assertCurrent() {},
  });
  try {
    const input = [
      { type: "function_call", call_id: "marker", name: "write_marker", arguments: "{}" },
      ...(!missingResult ? [{ type: "function_call_output", call_id: "marker", output }] : []),
    ];
    const result = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const outgoing = request(
        proxy.baseUrl + "/responses",
        { method: "POST", agent: false, headers: { "content-type": "application/json" } },
        async (response) => {
          try {
            const parts: Buffer[] = [];
            for await (const part of response) parts.push(Buffer.from(part));
            resolve({ status: response.statusCode!, text: Buffer.concat(parts).toString() });
          } catch (error) {
            reject(error);
          }
        },
      );
      outgoing.once("error", reject);
      outgoing.end(
        JSON.stringify({
          model: "gpt-fixture",
          input,
          tools: [],
          client_metadata: {
            "x-codex-turn-metadata": JSON.stringify({
              thread_id: "synthetic",
              turn_id: "turn",
              request_kind: "turn",
              openclaw_inference_generation: registration.generation,
            }),
          },
        }),
      );
    });
    expect(writes).toBe(1);
    expect(await readFile(marker, "utf8")).toBe(output);
    return { ...result, primary, fallback, checkpoint: [...rows.values()][0]?.value };
  } finally {
    registration.release();
    proxy.close();
    await rm(directory, { recursive: true, force: true });
  }
}
describe("real HTTP proxy continuation with external provider fixtures", () => {
  it("the per-attempt deadline aborts upstream I/O before fallback dispatch", async () => {
    const deadline = new AbortController();
    const originalTimeout = AbortSignal.timeout;
    let attempts = 0;
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      if (ms === 120_000 && attempts++ === 0) return deadline.signal;
      return originalTimeout(ms);
    });
    try {
      const result = await scenario("server_error", false, () => deadline.abort());
      expect(result.status).toBe(200);
      expect(result.primary).toBe(1);
      expect(result.fallback).toBe(1);
    } finally {
      timeout.mockRestore();
    }
  });

  it("marker -> 503 -> saved tool result -> fallback, without replaying the effect", async () => {
    const result = await scenario("server_error");
    expect(result.status).toBe(200);
    expect(result.text).toContain("continued");
    expect(result.primary).toBe(1);
    expect(result.fallback).toBe(1);
    expect(result.checkpoint?.phase).toBe("completed");
  });
  it("policy refusal after an effect stops without calling fallback", async () => {
    const result = await scenario("cyber_policy");
    expect(result.status).toBe(400);
    expect(result.primary).toBe(1);
    expect(result.fallback).toBe(0);
    expect(result.checkpoint?.terminalReceipt?.reason).toBe("cyber_policy");
  });
  it("lost effect result requires reconciliation before either provider", async () => {
    const result = await scenario("server_error", true);
    expect(result.status).toBe(400);
    expect(result.primary).toBe(0);
    expect(result.fallback).toBe(0);
    expect(result.checkpoint?.terminalReceipt?.reason).toBe("reconciliation_required");
  });
});
