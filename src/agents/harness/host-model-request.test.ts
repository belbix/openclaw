import { afterEach, describe, expect, it, vi } from "vitest";
const calls = vi.hoisted(() => ({ prepare: vi.fn(), complete: vi.fn() }));
vi.mock("../simple-completion-runtime.js", () => ({
  acquireSimpleCompletionModelForAgent: calls.prepare,
  completeWithPreparedSimpleCompletionModel: calls.complete,
}));
import { completeHarnessModelRequest } from "./host-model-request.js";

afterEach(() => vi.resetAllMocks());
function fixture() {
  const release = vi.fn();
  const controller = new AbortController();
  const binding = { signal: controller.signal, assertCurrent: vi.fn(), release };
  const source = {
    assertCurrent: vi.fn(),
    release: vi.fn(),
    bindModelExecution: vi.fn(() => binding),
  };
  const request = {
    model: "moonshot/kimi-fixture",
    context: { messages: [] },
    maxTokens: 100,
    signal: controller.signal,
    reserveBudget: vi.fn(async (_usd: number) => {}),
  };
  const prepared = {
    selection: { provider: "moonshot", modelId: "kimi-fixture" },
    model: { cost: { input: 1, output: 2, cacheRead: 0.2, cacheWrite: 1 } },
    auth: {},
    [Symbol.asyncDispose]: vi.fn(async () => {}),
  };
  calls.prepare.mockResolvedValue(prepared);
  calls.complete.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
  return { source, request, prepared, release, controller };
}
describe("host-owned continuation model admission", () => {
  it("denies a forbidden model before credential preparation or dispatch", async () => {
    const f = fixture();
    f.source.bindModelExecution.mockImplementation(() => {
      throw new Error("model forbidden");
    });
    await expect(
      completeHarnessModelRequest({
        cfg: {},
        agentId: "crypta",
        source: f.source,
        request: f.request,
      }),
    ).rejects.toThrow("model forbidden");
    expect(calls.prepare).not.toHaveBeenCalled();
    expect(calls.complete).not.toHaveBeenCalled();
  });
  it("stops an exhausted reservation before paid provider I/O", async () => {
    const f = fixture();
    f.request.reserveBudget.mockRejectedValue(new Error("budget exhausted"));
    await expect(
      completeHarnessModelRequest({
        cfg: {},
        agentId: "crypta",
        source: f.source,
        request: f.request,
      }),
    ).rejects.toThrow("budget exhausted");
    expect(calls.complete).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledOnce();
  });
  it("does not select a different effective model silently", async () => {
    const f = fixture();
    f.prepared.selection.modelId = "other-model";
    await expect(
      completeHarnessModelRequest({
        cfg: {},
        agentId: "crypta",
        source: f.source,
        request: f.request,
      }),
    ).rejects.toThrow("route changed");
    expect(calls.complete).not.toHaveBeenCalled();
  });
  it("requires valid auth preparation, without calling fallback of its own", async () => {
    const f = fixture();
    calls.prepare.mockResolvedValue({ error: "missing auth" });
    await expect(
      completeHarnessModelRequest({
        cfg: {},
        agentId: "crypta",
        source: f.source,
        request: f.request,
      }),
    ).rejects.toThrow("model/auth");
    expect(calls.complete).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledOnce();
  });
  it("reserves a conservative bound and performs one admitted request", async () => {
    const f = fixture();
    await completeHarnessModelRequest({
      cfg: {},
      agentId: "crypta",
      source: f.source,
      request: f.request,
    });
    expect(f.request.reserveBudget.mock.calls[0]?.[0]).toBeGreaterThan(0);
    expect(calls.complete).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledOnce();
  });
});
