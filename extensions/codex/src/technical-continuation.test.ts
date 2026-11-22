import { describe, expect, it, vi } from "vitest";
import type { NativeModelSource } from "./app-server/native-subagent-monitor-types.js";
import {
  createTechnicalContinuation,
  type ContinuationStore,
  type Checkpoint,
  type ContinuationScope,
} from "./app-server/technical-continuation.js";

function storeFixture() {
  const rows = new Map<string, { revision: number; value: Checkpoint }>();
  const store: ContinuationStore = {
    async observe(key) {
      const row = rows.get(key);
      return {
        value: row ? structuredClone(row.value) : undefined,
        comparison: String(row?.revision ?? 0),
      };
    },
    async compareAndApply(key, comparison, intent) {
      const row = rows.get(key);
      if (String(row?.revision ?? 0) !== comparison) return { status: "conflict" };
      rows.set(key, { revision: (row?.revision ?? 0) + 1, value: structuredClone(intent.value) });
      return { status: "applied" };
    },
  };
  return { store, rows };
}
const body = {
  model: "gpt-fixture",
  input: [
    {
      type: "function_call",
      call_id: "marker-call",
      name: "write_marker",
      arguments: '{"marker":"once"}',
    },
    { type: "function_call_output", call_id: "marker-call", output: "marker-written-once" },
  ],
  tools: [],
};
const success = () =>
  new Response(
    'data: {"type":"response.completed","response":{"id":"resp_fixture","status":"completed","output":[]}}\n\n',
  );
const failure = (code = "server_error", status = 503) =>
  new Response(JSON.stringify({ error: { code, type: code } }), { status });
function setup(
  overrides: Record<string, unknown> = {},
  scopeOverrides: Partial<ContinuationScope> = {},
) {
  const { store, rows } = storeFixture();
  let fallbacks = 0;
  const events: string[] = [];
  const source: NativeModelSource = {
    assertCurrent() {},
    release() {},
    async completeModelRequest(request) {
      fallbacks++;
      await request.reserveBudget(0.01);
      expect(
        request.context.messages.find(
          (m) => m.role === "toolResult" && m.toolCallId === "marker-call",
        ),
      ).toMatchObject({
        role: "toolResult",
        toolCallId: "marker-call",
        content: [{ type: "text", text: "marker-written-once" }],
      });
      return {
        role: "assistant",
        content: [{ type: "text", text: "continued with saved result" }],
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
  const run = createTechnicalContinuation({
    scope: {
      agentId: "crypta",
      sessionId: "session-fixture",
      runId: "logical-turn",
      observeDeliveries: async () => ({ source: "missing" as const, terminal: "missing" as const }),
      logicalTurnId: () => "durable-logical-turn",
      config: {
        enabled: true,
        maxTransientRetries: 0,
        fallbackModel: "moonshot/kimi-fixture",
        ...overrides,
      },
      ...scopeOverrides,
    },
    source,
    store,
    turnId: "native-turn",
    reserveBudget: async () => {},
    event: (e) => events.push(e.name),
  });
  const request = (
    primary: () => Promise<Response>,
    nextBody = body,
    signal = new AbortController().signal,
  ) => ({ body: nextBody, signal, assertCurrent() {}, primary });
  return {
    run,
    request,
    store,
    rows,
    events,
    source,
    get fallbacks() {
      return fallbacks;
    },
  };
}

describe("single model-request continuation (no agent replay)", () => {
  it("passes committed tool output to fallback and persists its terminal receipt", async () => {
    const f = setup();
    let primaryCalls = 0;
    const result = await f.run(
      f.request(async () => {
        primaryCalls++;
        return failure();
      }),
    );
    expect(result.body.toString()).toContain("continued with saved result");
    expect(primaryCalls).toBe(1);
    expect(f.fallbacks).toBe(1);
    expect([...f.rows.values()][0]?.value).toMatchObject({
      phase: "completed",
      transitions: 1,
      completed: [
        {
          id: "marker-call",
          argumentsHash: expect.any(String),
          receipt: expect.stringContaining("checkpoint:"),
        },
      ],
    });
    expect(f.events).toContain("continuation_completed");
  });
  it.each([
    "policy_refusal",
    "cyber_policy",
    "invalid_api_key",
    "insufficient_quota",
    "budget_exhausted",
    "unknown_error",
  ])("stops %s without fallback", async (code) => {
    const f = setup();
    await expect(f.run(f.request(async () => failure(code)))).rejects.toThrow();
    expect(f.fallbacks).toBe(0);
    expect([...f.rows.values()][0]?.value.phase).toBe("stopped");
  });
  it("does not admit inference with a missing tool result", async () => {
    const f = setup();
    let calls = 0;
    await expect(
      f.run(
        f.request(
          async () => {
            calls++;
            return success();
          },
          { ...body, input: [body.input[0]!] },
        ),
      ),
    ).rejects.toThrow("reconciliation_required");
    expect(calls).toBe(0);
    expect(f.fallbacks).toBe(0);
  });
  it("fences a concurrent owner and a replayed completed request", async () => {
    const f = setup();
    let resume!: (r: Response) => void;
    const pending = f.run(
      f.request(
        () =>
          new Promise((r) => {
            resume = r;
          }),
      ),
    );
    // Await the actual external request boundary, not a timer.
    while (!resume) await Promise.resolve();
    await expect(f.run(f.request(async () => success()))).rejects.toThrow(
      "reconciliation_required",
    );
    resume(success());
    await pending;
    await expect(f.run(f.request(async () => success()))).rejects.toThrow(
      "reconciliation_required",
    );
  });
  it("preserves a cancelled request without releasing late content", async () => {
    const f = setup();
    const controller = new AbortController();
    let resume!: (r: Response) => void;
    const pending = f.run(
      f.request(
        () =>
          new Promise((r) => {
            resume = r;
          }),
        body,
        controller.signal,
      ),
    );
    while (!resume) await Promise.resolve();
    controller.abort();
    resume(success());
    await expect(pending).rejects.toThrow("cancelled");
    expect(f.fallbacks).toBe(0);
    expect([...f.rows.values()][0]?.value.cancelled).toBe(true);
  });
  it("uses a bounded retry without invoking fallback", async () => {
    const f = setup({ maxTransientRetries: 2 });
    let calls = 0;
    await f.run(f.request(async () => (++calls < 3 ? failure() : success())));
    expect(calls).toBe(3);
    expect(f.fallbacks).toBe(0);
  });
  it("does not reinterpret an untyped 503 as technical", async () => {
    const f = setup();
    await expect(
      f.run(f.request(async () => new Response("upstream mystery", { status: 503 }))),
    ).rejects.toThrow("unknown_provider_error");
    expect(f.fallbacks).toBe(0);
  });
  it("refuses provider-specific incremental history", async () => {
    const f = setup();
    await expect(
      f.run(
        f.request(async () => success(), {
          ...body,
          previous_response_id: "private-id",
        } as typeof body),
      ),
    ).rejects.toThrow("incompatible_history");
    expect(f.fallbacks).toBe(0);
  });
  it("keeps the effective fallback for later requests in the same logical turn", async () => {
    const f = setup();
    await f.run(f.request(async () => failure()));
    const next = {
      ...body,
      input: [
        ...body.input,
        { role: "user", content: [{ type: "input_text", text: "next boundary" }] },
      ],
    };
    let primary = 0;
    await f.run(
      f.request(async () => {
        primary++;
        return success();
      }, next),
    );
    expect(primary).toBe(0);
    expect(f.fallbacks).toBe(2);
    expect([...f.rows.values()][0]?.value.transitions).toBe(1);
  });
  it("journals scheduled effects before exposing their response", async () => {
    const f = setup();
    const reply = new Response(
      'data: {"type":"response.completed","response":{"id":"next","status":"completed","output":[{"type":"function_call","call_id":"next-effect","name":"send_message","arguments":"{}"}]}}\n\n',
    );
    await f.run(f.request(async () => reply));
    expect([...f.rows.values()][0]?.value.uncertain).toEqual(["next-effect"]);
    await expect(
      f.run(
        f.request(async () => success(), {
          ...body,
          input: [
            ...body.input,
            { role: "user", content: [{ type: "input_text", text: "resume after restart" }] },
          ],
        }),
      ),
    ).rejects.toThrow("reconciliation_required");
  });
  it.each([
    ['{"marker":"once"}', '{"marker":"once"}', true],
    ['{"marker":"once"}', '{ "marker": "once" }', true],
    ['{"marker":"once"}', '{"marker":"\\u006fnce"}', true],
    [
      '{"marker":"once","options":{"a":1,"b":2}}',
      '{"options":{"b":2,"a":1},"marker":"once"}',
      true,
    ],
    ['{"markers":[1,2]}', '{"markers":[2,1]}', false],
    ['{"marker":"once"}', '{"marker":"twice"}', false],
  ])("guards committed tool arguments %s versus %s", async (saved, repeated, duplicate) => {
    const f = setup();
    const reply = new Response(
      "data: " +
        JSON.stringify({
          type: "response.completed",
          response: {
            id: "next",
            status: "completed",
            output: [
              {
                type: "function_call",
                call_id: "renamed",
                name: "write_marker",
                arguments: repeated,
              },
            ],
          },
        }) +
        "\n\n",
    );
    const pending = f.run(
      f.request(async () => reply, {
        ...body,
        input: [{ ...body.input[0]!, arguments: saved }, body.input[1]!],
      }),
    );
    if (duplicate) await expect(pending).rejects.toThrow("duplicate_tool_call");
    else await expect(pending).resolves.toMatchObject({ status: 200 });
    expect(f.fallbacks).toBe(0);
  });
  it.each([401, 403, 402])(
    "does not retry a misleading server_error in HTTP %s",
    async (status) => {
      const f = setup({ maxTransientRetries: 2 });
      let calls = 0;
      await expect(
        f.run(
          f.request(async () => {
            calls++;
            return failure("server_error", status);
          }),
        ),
      ).rejects.toThrow(status === 402 ? "budget_exhausted" : "authentication_failed");
      expect(calls).toBe(1);
      expect(f.fallbacks).toBe(0);
    },
  );
  it("detects checkpoint corruption before provider I/O", async () => {
    const f = setup();
    await f.run(f.request(async () => success()));
    const row = [...f.rows.values()][0]!;
    row.value.history.model = "corrupted";
    let calls = 0;
    await expect(
      f.run(
        f.request(
          async () => {
            calls++;
            return success();
          },
          { ...body, instructions: "next" } as typeof body,
        ),
      ),
    ).rejects.toThrow("invalid_checkpoint");
    expect(calls).toBe(0);
    expect(f.fallbacks).toBe(0);
  });
  it("does not forget completed calls when native history compacts them away", async () => {
    const f = setup();
    await f.run(f.request(async () => success()));
    const repeated = new Response(
      "data: " +
        JSON.stringify({
          type: "response.completed",
          response: {
            status: "completed",
            output: [
              {
                type: "function_call",
                call_id: "new-id",
                name: "write_marker",
                arguments: '{"marker":"once"}',
              },
            ],
          },
        }) +
        "\n\n",
    );
    await expect(
      f.run(
        f.request(async () => repeated, {
          ...body,
          input: [{ role: "user", content: [{ type: "input_text", text: "compacted" }] }],
        }),
      ),
    ).rejects.toThrow("duplicate_tool_call");
  });
  it("keeps feature-off requests out of the checkpoint owner", async () => {
    const f = setup({ enabled: false });
    let primary = 0;
    await expect(
      f.run(
        f.request(async () => {
          primary++;
          return success();
        }),
      ),
    ).rejects.toThrow("feature_disabled");
    expect(primary).toBe(0);
    expect(f.rows.size).toBe(0);
  });
});

describe("source-delivery and provider reasoning boundaries", () => {
  it.each(["pending", "unknown"] as const)(
    "checkpoints %s delivery and stops without model I/O",
    async (state) => {
      const f = setup(
        {},
        { observeDeliveries: async () => ({ source: state, terminal: "missing" }) },
      );
      let calls = 0;
      await expect(
        f.run(
          f.request(async () => {
            calls++;
            return failure();
          }),
        ),
      ).rejects.toThrow("reconciliation_required");
      expect(calls).toBe(0);
      expect(f.fallbacks).toBe(0);
      expect([...f.rows.values()][0]?.value).toMatchObject({
        phase: "stopped",
        deliveries: { source: state },
      });
    },
  );
  it("retains confirmed source facts without manufacturing platform receipts", async () => {
    const f = setup(
      {},
      { observeDeliveries: async () => ({ source: "delivered", terminal: "delivered" }) },
    );
    await f.run(f.request(async () => success()));
    expect([...f.rows.values()][0]?.value.deliveries).toEqual({
      source: "delivered",
      terminal: "delivered",
    });
  });
  it("never projects private fallback reasoning into the native stream", async () => {
    const f = setup();
    const complete = f.source.completeModelRequest!;
    f.source.completeModelRequest = async (request) => ({
      ...(await complete(request)),
      content: [
        {
          type: "thinking",
          thinking: "private-provider-reasoning",
          thinkingSignature: "private-signature",
        },
        { type: "text", text: "public answer" },
      ],
    });
    const response = await f.run(f.request(async () => failure()));
    expect(response.body.toString()).toContain("public answer");
    expect(response.body.toString()).not.toContain("private-provider-reasoning");
    expect(response.body.toString()).not.toContain("private-signature");
  });
  it("isolates two native branches in the same session and logical turn", async () => {
    const f = setup({}, { branchId: "parent-thread" });
    await f.run(f.request(async () => success()));
    const child = createTechnicalContinuation({
      scope: {
        agentId: "crypta",
        sessionId: "session-fixture",
        runId: "logical-turn",
        branchId: "child-thread",
        logicalTurnId: () => "durable-logical-turn",
        observeDeliveries: async () => ({ source: "missing", terminal: "missing" }),
        config: { enabled: true },
      },
      source: f.source,
      store: f.store,
      turnId: "native-child",
      reserveBudget: async () => {},
    });
    await child(f.request(async () => success()));
    expect(f.rows.size).toBe(2);
  });
});

describe("fallback deadline fencing", () => {
  it("never releases a late fallback result when the provider ignores cancellation", async () => {
    const f = setup();
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const complete = f.source.completeModelRequest!;
    f.source.completeModelRequest = async (request) => {
      const result = await complete(request);
      deadline.abort(new DOMException("deadline", "TimeoutError"));
      return result;
    };
    try {
      await expect(f.run(f.request(async () => failure()))).rejects.toThrow("continuation_failed");
      expect([...f.rows.values()][0]?.value.phase).toBe("stopped");
      expect(f.events).not.toContain("continuation_completed");
    } finally {
      timeout.mockRestore();
    }
  });
});
