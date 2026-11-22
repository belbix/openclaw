import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { describe, expect, it } from "vitest";
import type { NativeModelSource } from "./app-server/native-subagent-monitor-types.js";
import { openTechnicalContinuation } from "./app-server/technical-continuation-store.js";

// No mocked checkpoint or budget store: the real plugin-state SQLite owner and
// its CAS API persist both state and reservations across independent handles.
describe("durable continuation state", () => {
  it("reopens chunked history and keeps the daily reservation across sessions", async () => {
    await withOpenClawTestState({ label: "continuation-state", scenario: "minimal" }, async () => {
      let paidCalls = 0;
      let reservation = 9;
      const source = {
        assertCurrent() {},
        release() {},
        async completeModelRequest(req) {
          await req.reserveBudget(reservation);
          paidCalls++;
          expect(req.context.messages).toContainEqual(
            expect.objectContaining({
              role: "toolResult",
              toolCallId: "effect",
              content: [{ type: "text", text: "durable result" }],
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
      const scope = {
        agentId: "crypta-fixture",
        sessionId: "first",
        runId: "run",
        observeDeliveries: async () => ({
          source: "missing" as const,
          terminal: "missing" as const,
        }),
        logicalTurnId: () => "logical",
        config: {
          enabled: true,
          maxTransientRetries: 0,
          fallbackModel: "moonshot/kimi-fixture",
          dailyBudgetUsd: 10,
        },
      };
      const body = {
        model: "gpt-fixture",
        instructions: "large history ".repeat(18000),
        input: [
          { type: "function_call", call_id: "effect", name: "write_marker", arguments: "{}" },
          { type: "function_call_output", call_id: "effect", output: "durable result" },
        ],
        tools: [],
      };
      const request = {
        body,
        signal: new AbortController().signal,
        assertCurrent() {},
        primary: async () =>
          new Response(JSON.stringify({ error: { code: "server_error" } }), { status: 503 }),
      };
      const first = await openTechnicalContinuation(scope, source, "native-turn");
      expect((await first(request)).status).toBe(200);
      const reopened = await openTechnicalContinuation(scope, source, "restarted-transport");
      await expect(reopened(request)).rejects.toThrow("reconciliation_required");
      expect(paidCalls).toBe(1);
      reservation = 2;
      const secondSession = await openTechnicalContinuation(
        { ...scope, sessionId: "second" },
        source,
        "new-native-turn",
      );
      await expect(secondSession(request)).rejects.toThrow("budget_exhausted");
      expect(paidCalls).toBe(1);
    });
  });
});
