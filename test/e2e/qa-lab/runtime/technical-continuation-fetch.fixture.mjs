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
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { ...item, status: "in_progress" },
      },
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
const requestBody = async (input, init) => {
  if (init?.body !== undefined) return await new Response(init.body).json();
  if (input instanceof Request) return await input.clone().json();
  return {};
};
const fixtureFetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname === "api.openai.com" && url.pathname.endsWith("/responses")) {
    const body = await requestBody(input, init);
    if (body.model !== process.env.CRYPTA_CANARY_PRIMARY_MODEL) {
      return sse({
        type: "message",
        id: "utility",
        role: "assistant",
        content: [{ type: "output_text", text: "Synthetic utility response", annotations: [] }],
      });
    }
    stats.primary++;
    const catalog =
      body.tools ??
      (body.input ?? []).find((item) => item.type === "additional_tools")?.tools ??
      [];
    const declared = catalog.flatMap((tool) =>
      tool.type === "namespace"
        ? (tool.tools ?? []).map((entry) => ({ ...entry, namespace: tool.name }))
        : [tool],
    );
    stats.nativeTools = declared.map(({ type, name, namespace, parameters }) => ({
      type,
      name,
      namespace,
      parametersType: typeof parameters,
    }));
    stats.inputShape = (body.input ?? []).map(({ type, role, content, namespace }) => ({
      type,
      role,
      namespace,
      contentType: typeof content,
      contentBlocks: Array.isArray(content) ? content.map((block) => block.type) : undefined,
    }));
    const result = (body.input ?? []).find(
      (item) =>
        ["function_call_output", "custom_tool_call_output"].includes(item.type) &&
        item.call_id === "crypta_marker",
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
    const tool =
      declared.find((entry) => entry.name === "exec_command") ??
      declared.find((entry) => entry.name === "exec");
    if (!tool)
      throw new Error(
        "Native canary requires a declared execution tool: " + JSON.stringify(stats.nativeTools),
      );
    if (tool.type === "custom") {
      return sse({
        type: "custom_tool_call",
        id: "ctc_marker",
        call_id: "crypta_marker",
        name: tool.name,
        ...(tool.namespace ? { namespace: tool.namespace } : {}),
        input:
          "text(await tools.exec_command(" +
          JSON.stringify({
            cmd: "node -e " + quote(script),
            yield_time_ms: 10000,
            max_output_tokens: 100,
          }) +
          "))",
      });
    }
    return sse({
      type: "function_call",
      id: "fc_marker",
      call_id: "crypta_marker",
      name: tool.name,
      ...(tool.namespace ? { namespace: tool.namespace } : {}),
      arguments: JSON.stringify(
        tool.name === "exec_command"
          ? { cmd: "node -e " + quote(script), yield_time_ms: 10000, max_output_tokens: 100 }
          : { command: "node -e " + quote(script), yieldMs: 10000 },
      ),
    });
  }
  if (url.hostname === "api.moonshot.ai" && url.pathname.endsWith("/chat/completions")) {
    const body = await requestBody(input, init);
    stats.fallback++;
    stats.hostedLimitationsExplicit = (body.messages ?? []).some(
      (message) =>
        message.role === "system" &&
        JSON.stringify(message.content).includes("not available in this continuation"),
    );
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
