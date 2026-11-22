import { describe, expect, it } from "vitest";
import {
  fallbackContext,
  fallbackResponse,
  snapshotRequest,
} from "./app-server/technical-continuation-protocol.js";

const request = {
  model: "gpt-fixture",
  input: [
    {
      type: "function_call",
      call_id: "done",
      namespace: "functions",
      name: "write_marker",
      arguments: '{"value":1}',
    },
    { type: "function_call_output", call_id: "done", output: "saved receipt" },
  ],
  tools: [
    {
      type: "namespace",
      name: "functions",
      description: "Host tools",
      tools: [
        {
          type: "function",
          name: "write_marker",
          description: "Write one marker",
          parameters: { type: "object", properties: { value: { type: "number" } } },
        },
      ],
    },
  ],
};

describe("native namespace continuation boundary", () => {
  it("retains qualified receipts and round-trips only the declared namespace", () => {
    expect(snapshotRequest(request).completed[0]).toMatchObject({
      namespace: "functions",
      name: "write_marker",
    });
    const context = fallbackContext(request);
    const name = context.tools![0]!.name;
    expect(context.messages.find((m) => m.role === "toolResult")).toMatchObject({ toolName: name });
    const result = {
      role: "assistant" as const,
      content: [{ type: "toolCall" as const, id: "next", name, arguments: { value: 2 } }],
      provider: "moonshot",
      model: "fixture",
      api: "openai-completions" as const,
      stopReason: "toolUse" as const,
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
    const text = fallbackResponse(result, ["done"], request.tools).toString();
    expect(text).toContain('"namespace":"functions"');
    expect(text).toContain('"name":"write_marker"');
  });
  it("rejects duplicate declarations instead of aliasing their authority", () => {
    expect(() =>
      fallbackContext({ ...request, tools: [...request.tools, ...request.tools] }),
    ).toThrow("ambiguous_tool_declaration");
  });
  it("does not silently discard an unsupported native tool declaration", () => {
    expect(() => fallbackContext({ ...request, tools: [{ type: "unknown_action" }] })).toThrow(
      "incompatible_history",
    );
  });
  it("does not merge identically named tools from different namespaces", () => {
    const other = structuredClone(request.tools[0]!);
    other.name = "other_host";
    const context = fallbackContext({ ...request, tools: [...request.tools, other] });
    expect(new Set(context.tools!.map((t) => t.name)).size).toBe(2);
  });
});
