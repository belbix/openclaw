import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, onTestFailed } from "vitest";
import type { GatewayClient } from "../../../../src/gateway/client.js";
import { loadOrCreateDeviceIdentity } from "../../../../src/infra/device-identity.js";
import { acquireGatewayTestClient } from "../../../helpers/gateway-client.js";
import { createOpenClawTestInstance } from "../../../helpers/openclaw-test-instance.js";

// Real built Gateway + pinned native Codex. Only provider network I/O is synthetic.
// This is not proof of a live Moonshot account or physical Telegram delivery.
describe("native Gateway technical continuation", () => {
  it.each([
    { failure: "technical", modelId: "gpt-5.5" },
    { failure: "policy", modelId: "gpt-5.5" },
    { failure: "technical", modelId: "gpt-6.1-sol" },
    { failure: "policy", modelId: "gpt-6.1-sol" },
  ])(
    "preserves one tool effect after $failure failure on $modelId",
    { timeout: 300_000 },
    async ({ failure, modelId }) => {
      const primary = `openai/${modelId}`;
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
          // Hermetic synthetic upstreams do not inherit runner-specific native trust/proxy profiles.
          HTTP_PROXY: undefined,
          HTTPS_PROXY: undefined,
          ALL_PROXY: undefined,
          NO_PROXY: undefined,
          http_proxy: undefined,
          https_proxy: undefined,
          all_proxy: undefined,
          no_proxy: undefined,
          SSL_CERT_FILE: undefined,
          CODEX_CA_CERTIFICATE: undefined,
          OPENCLAW_SKIP_PROVIDERS: undefined,
          OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
          OPENAI_API_KEY: "synthetic-openai-canary",
          MOONSHOT_API_KEY: "synthetic-moonshot-canary",
          CRYPTA_CANARY_FAILURE: failure,
          CRYPTA_CANARY_PRIMARY_MODEL: modelId,
        },
        config: {
          models: {
            providers: {
              openai: {
                baseUrl: "https://api.openai.com/v1",
                api: "openai-responses",
                apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
                models: [model(modelId)],
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
      let providerEvidence = "no provider I/O observed";
      onTestFailed(() => {
        console.error(instance.logs());
        console.error("Synthetic provider evidence:", providerEvidence);
      });
      const marker = instance.state.path("effect-marker");
      const evidence = instance.state.path("provider-evidence.json");
      instance.env.CRYPTA_CANARY_MARKER = marker;
      instance.env.CRYPTA_CANARY_EVIDENCE = evidence;
      let client: GatewayClient | undefined;
      const filteredBundled = path.resolve("dist", `crypta-canary-plugins-${randomUUID()}`);
      try {
        // Source builds include a workspace Codex bundle; published core excludes it.
        // Retain every other real bundled plugin and select the packed Codex owner only.
        const bundled = path.resolve("dist/extensions");
        await fs.mkdir(filteredBundled, { recursive: true });
        for (const entry of await fs.readdir(bundled, { withFileTypes: true })) {
          if (entry.isDirectory() && entry.name !== "codex")
            await fs.cp(path.join(bundled, entry.name), path.join(filteredBundled, entry.name), {
              recursive: true,
              dereference: true,
            });
        }
        instance.env.OPENCLAW_BUNDLED_PLUGINS_DIR = filteredBundled;
        instance.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR = "1";
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
        // Status CLI clients intentionally have no human profile/source custody.
        // Authenticate a real local owner UI socket through the normal Gateway admission.
        client = await acquireGatewayTestClient(
          {
            url: instance.url,
            origin: `http://127.0.0.1:${instance.port}`,
            token: instance.gatewayToken,
            env: instance.env,
            role: "operator",
            clientName: "webchat-ui",
            clientDisplayName: "Crypta continuation owner proof",
            mode: "webchat",
            scopes: ["operator.admin", "operator.read", "operator.write"],
            deviceIdentity: loadOrCreateDeviceIdentity({
              path: instance.state.path("owner-device.sqlite"),
            }),
          },
          {
            timeoutMs: 15_000,
            timeoutMessage: "Owner UI connection timed out",
            closeMessage: "Owner UI closed",
          },
        );
        const self = await client.request<{ profile: { id: string } }>("users.self", {});
        expect(self.profile.id).toBeTruthy();
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
        console.log("Native terminal:", JSON.stringify(terminal));
        expect(await fs.readFile(marker, "utf8")).toBe("one");
        const stats = JSON.parse(await fs.readFile(evidence, "utf8"));
        expect(stats).toMatchObject({
          primary: 2,
          failedAfterTool: 1,
          fallback: failure === "technical" ? 1 : 0,
          savedResult: true,
        });
        if (failure === "technical") expect(stats.hostedLimitationsExplicit).toBe(true);
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
        providerEvidence = await fs
          .readFile(evidence, "utf8")
          .catch(() => "no provider I/O observed");
        client?.stop();
        await instance.cleanup();
        await fs.rm(filteredBundled, { recursive: true, force: true });
      }
    },
  );
});
