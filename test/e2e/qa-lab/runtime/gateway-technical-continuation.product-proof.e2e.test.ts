import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, onTestFailed } from "vitest";
import { connectGatewayStatusClient } from "../../../helpers/gateway-e2e-harness.js";
import { createOpenClawTestInstance } from "../../../helpers/openclaw-test-instance.js";

// Real built Gateway + pinned native Codex. Only provider network I/O is synthetic.
// This is not proof of a live Moonshot account or physical Telegram delivery.
describe("native Gateway technical continuation", () => {
  it.each(["technical", "policy"])(
    "preserves one tool effect after %s failure",
    { timeout: 300_000 },
    async (failure) => {
      const primary = "openai/gpt-5.5";
      const fallback = "moonshot/kimi-fixture";
      const model = (id: string) => ({
        id,
        name: id,
        reasoning: false,
        input: ["text"],
        contextWindow: 65536,
        maxTokens: 8192,
        cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
      });
      const instance = await createOpenClawTestInstance({
        name: "crypta-native-continuation",
        entrypoint: [
          "--import",
          fileURLToPath(new URL("./technical-continuation-fetch.fixture.mjs", import.meta.url)),
          "dist/index.js",
        ],
        env: {
          OPENCLAW_SKIP_PROVIDERS: undefined,
          OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
          OPENAI_API_KEY: "synthetic-openai-canary",
          MOONSHOT_API_KEY: "synthetic-moonshot-canary",
          CRYPTA_CANARY_FAILURE: failure,
        },
        config: {
          models: {
            providers: {
              openai: {
                baseUrl: "https://api.openai.com/v1",
                api: "openai-responses",
                apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
                models: [model("gpt-5.5")],
              },
              moonshot: {
                baseUrl: "https://api.moonshot.ai/v1",
                api: "openai-completions",
                apiKey: { source: "env", provider: "default", id: "MOONSHOT_API_KEY" },
                models: [model("kimi-fixture")],
              },
            },
          },
          plugins: {
            enabled: true,
            allow: ["codex", "moonshot"],
            entries: {
              codex: {
                enabled: true,
                config: {
                  appServer: { mode: "yolo", homeScope: "agent", cyberFailover: { mode: "off" } },
                  technicalContinuation: {
                    main: {
                      enabled: true,
                      fallbackModel: fallback,
                      maxTransientRetries: 0,
                      dailyBudgetUsd: 10,
                    },
                  },
                },
              },
              moonshot: { enabled: true },
            },
          },
          agents: {
            defaults: {
              model: { primary, fallbacks: [] },
              models: { [primary]: { agentRuntime: { id: "codex" } }, [fallback]: {} },
              workspace: "~/workspace",
              skipBootstrap: true,
              timeoutSeconds: 120,
              sandbox: { mode: "off" },
            },
          },
        },
      });
      onTestFailed(async () => {
        console.error(instance.logs());
        const observed = await fs
          .readFile(instance.state.path("provider-evidence.json"), "utf8")
          .catch(() => "no provider I/O observed");
        console.error("Synthetic provider evidence:", observed);
      });
      const marker = instance.state.path("effect-marker");
      const evidence = instance.state.path("provider-evidence.json");
      instance.env.CRYPTA_CANARY_MARKER = marker;
      instance.env.CRYPTA_CANARY_EVIDENCE = evidence;
      let client: Awaited<ReturnType<typeof connectGatewayStatusClient>> | undefined;
      try {
        const packedPlugin = process.env.CRYPTA_CANARY_CODEX_TARBALL;
        if (!packedPlugin) throw new Error("Canary requires the candidate Codex tarball");
        const installed = await instance.cli(
          ["plugins", "install", packedPlugin, "--force", "--accept-capabilities"],
          {
            timeoutMs: 120_000,
          },
        );
        expect(installed.code, installed.stderr + installed.stdout).toBe(0);
        await instance.startGateway();
        client = await connectGatewayStatusClient(instance);
        const sessionKey = `agent:main:continuation-${randomUUID()}`;
        const started = await client.request<{ runId: string; status: string }>("chat.send", {
          sessionKey,
          message: "Complete the harmless synthetic marker task.",
          deliver: false,
          idempotencyKey: randomUUID(),
        });
        expect(started.status).toBe("started");
        const terminal = await client.request<{ status: string }>(
          "agent.wait",
          { runId: started.runId, timeoutMs: 120_000 },
          { timeoutMs: 125_000 },
        );
        expect(await fs.readFile(marker, "utf8")).toBe("one");
        const stats = JSON.parse(await fs.readFile(evidence, "utf8"));
        expect(stats).toMatchObject({
          primary: 2,
          failedAfterTool: 1,
          fallback: failure === "technical" ? 1 : 0,
          savedResult: true,
        });
        expect(terminal.status).toBe(failure === "technical" ? "ok" : "error");
        const history = await client.request<{ messages: unknown[] }>("chat.history", {
          sessionKey,
          limit: 30,
        });
        if (failure === "technical")
          expect(JSON.stringify(history.messages)).toContain("CRYPTA_CONTINUATION_OK");
        console.log(
          JSON.stringify({
            proof: "crypta-native-continuation",
            failure,
            terminal: terminal.status,
            ...stats,
            markerWrites: 1,
          }),
        );
      } finally {
        client?.stop();
        await instance.cleanup();
      }
    },
  );
});
