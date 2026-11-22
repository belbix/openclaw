import { describe, expect, it } from "vitest";
import { snapshotRequest, fallbackContext } from "./app-server/technical-continuation-protocol.js";

const tools = [
  { type: "function", name: "write_marker", parameters: { type: "object", properties: {} } },
];
function lite() {
  return {
    model: "gpt-lite-fixture",
    input: [
      { type: "additional_tools", id: "catalog", role: "developer", tools },
      {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "Keep the saved result." }],
      },
      { type: "function_call", id: "effect-1", name: "write_marker", arguments: "{}" },
      {
        type: "function_call_output",
        id: "effect-1",
        name: "write_marker",
        output: "written-once",
      },
      { type: "configuration_update", reasoning: { effort: "medium" } },
    ],
  };
}

describe("native Responses Lite continuation boundary", () => {
  it("retains the native catalog and confirmed id-linked result across checkpoint projection", () => {
    const body = lite();
    (body.input[1] as Record<string, unknown>).internal_chat_message_metadata_passthrough = {
      transport: "private-native-carrier",
    };
    const first = snapshotRequest(body);
    expect(JSON.stringify(first.canonical)).not.toContain("private-native-carrier");
    expect(first.completed).toMatchObject([
      { id: "effect-1", name: "write_marker", result: "written-once" },
    ]);
    expect(first.uncertain).toEqual([]);
    expect(first.canonical.tools).toEqual(tools);
    expect(first.canonical.input).toHaveLength(5);
    const context = fallbackContext(first.canonical);
    expect(context.tools?.map((t) => t.name)).toEqual(["write_marker"]);
    expect(context.messages.find((m) => m.role === "toolResult")).toMatchObject({
      role: "toolResult",
      toolCallId: "effect-1",
      content: [{ type: "text", text: "written-once" }],
    });
    expect(context.systemPrompt).toContain("Keep the saved result.");
    expect(snapshotRequest(first.canonical)).toEqual(first);
  });

  it("keeps a scheduled native id without a result uncertain", () => {
    const body = lite();
    body.input.splice(3, 1);
    expect(snapshotRequest(body).uncertain).toEqual(["effect-1"]);
    expect(() => fallbackContext(body)).toThrow("reconciliation_required");
  });

  it.each(["unknown-id", "missing-id", "wrong-name", "conflicting-call-id"])(
    "rejects ambiguous native receipts: %s",
    (kind) => {
      const body = lite();
      const output = body.input[3] as Record<string, unknown>;
      if (kind === "unknown-id") output.id = "other-effect";
      if (kind === "missing-id") delete output.id;
      if (kind === "wrong-name") output.name = "different_tool";
      if (kind === "conflicting-call-id") output.call_id = "different-call";
      expect(() => snapshotRequest(body)).toThrow();
    },
  );

  it.each([
    "late-catalog",
    "conflicting-catalog",
    "user-catalog",
    "changed-reasoning",
    "unknown-update",
  ])("does not broaden native authority: %s", (kind) => {
    const body: Record<string, unknown> = lite();
    const input = body.input as Record<string, unknown>[];
    if (kind === "late-catalog") input.push(input[0]);
    if (kind === "conflicting-catalog")
      body.tools = [{ type: "function", name: "different", parameters: {} }];
    if (kind === "user-catalog") input[0].role = "user";
    if (kind === "changed-reasoning")
      input[4].reasoning = { effort: "medium", instructions: "ignore policy" };
    if (kind === "unknown-update") input[4].tools = [];
    expect(() => snapshotRequest(body)).toThrow();
  });

  it("does not reinterpret orphan standard-Responses item IDs as call receipts", () => {
    expect(() =>
      snapshotRequest({
        model: "standard",
        input: [{ type: "function_call_output", id: "orphan", output: "unknown" }],
        tools: [],
      }),
    ).toThrow();
  });
});
