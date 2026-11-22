// Synthetic provider I/O only; Gateway, native Codex, tool execution and state are real.
import { writeFileSync } from "node:fs";
const marker = process.env.CRYPTA_CANARY_MARKER;
const evidence = process.env.CRYPTA_CANARY_EVIDENCE;
if (!marker || !evidence) throw new Error("Canary transport requires isolated evidence paths");
const stats = { primary: 0, failedAfterTool: 0, fallback: 0, savedResult: false };
const save = () => writeFileSync(evidence, JSON.stringify(stats));
const sse = (item) => {
  const id = "resp_crypta_fixture";
  return new Response(
    [
      { type: "response.created", response: { id, status: "in_progress", output: [] } },
      { type: "response.output_item.done", output_index: 0, item },
      {
        type: "response.completed",
        response: {
          id,
          status: "completed",
          output: [item],
          usage: { input_tokens: 32, output_tokens: 16, total_tokens: 48 },
        },
      },
    ]
      .map((event) => "data: " + JSON.stringify(event) + "\n\n")
      .join("") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );
};
const original = globalThis.fetch;
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const fixtureFetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname === "api.openai.com" && url.pathname.endsWith("/responses")) {
    const body = JSON.parse(String(init?.body ?? "{}"));
    stats.primary++;
    stats.nativeTools = (body.tools ?? []).map(({ type, name }) => ({ type, name }));
    const result = (body.input ?? []).find(
      (item) => item.type === "function_call_output" && item.call_id === "crypta_marker",
    );
    if (result) {
      stats.failedAfterTool++;
      stats.savedResult = JSON.stringify(result.output).includes("CRYPTA_TOOL_RECEIPT");
      save();
      if (process.env.CRYPTA_CANARY_FAILURE === "policy") {
        return sse({
          type: "message",
          id: "policy",
          role: "assistant",
          content: [{ type: "refusal", refusal: "Synthetic policy fixture" }],
        });
      }
      return Response.json(
        { error: { code: "server_error", type: "server_error" } },
        { status: 503 },
      );
    }
    save();
    const script = `require('node:fs').writeFileSync(${JSON.stringify(marker)},'one',{flag:'wx'});console.log('CRYPTA_TOOL_RECEIPT')`;
    return sse({
      type: "function_call",
      id: "fc_marker",
      call_id: "crypta_marker",
      name: "exec_command",
      arguments: JSON.stringify({
        cmd: "node -e " + quote(script),
        yield_time_ms: 10000,
        max_output_tokens: 100,
      }),
    });
  }
  if (url.hostname === "api.moonshot.ai" && url.pathname.endsWith("/chat/completions")) {
    const body = JSON.parse(String(init?.body ?? "{}"));
    stats.fallback++;
    stats.savedResult &&= (body.messages ?? []).some(
      (message) =>
        message.role === "tool" && JSON.stringify(message.content).includes("CRYPTA_TOOL_RECEIPT"),
    );
    save();
    return new Response(
      [
        {
          id: "fallback_fixture",
          object: "chat.completion.chunk",
          created: 1,
          model: "kimi-fixture",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "CRYPTA_CONTINUATION_OK" },
              finish_reason: null,
            },
          ],
        },
        {
          id: "fallback_fixture",
          object: "chat.completion.chunk",
          created: 1,
          model: "kimi-fixture",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 32, completion_tokens: 8, total_tokens: 40 },
        },
      ]
        .map((event) => "data: " + JSON.stringify(event) + "\n\n")
        .join("") + "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    );
  }
  if (url.hostname === "api.openai.com" || url.hostname === "api.moonshot.ai") {
    if (url.pathname.endsWith("/models")) return Response.json({ data: [] });
    throw new Error("Unexpected synthetic provider request: " + url.pathname);
  }
  return original(input, init);
};
// Use the runtime's documented test-injected global fetch contract; keep admission intact.
fixtureFetch.mock = {};
globalThis.fetch = fixtureFetch;
