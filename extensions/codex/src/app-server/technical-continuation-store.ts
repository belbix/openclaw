import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createPluginStateKeyedStoreV2 } from "openclaw/plugin-sdk/plugin-state-store-runtime";
import type { NativeModelSource } from "./native-subagent-monitor-types.js";
import { digest, ContinuationStopped } from "./technical-continuation-protocol.js";
import {
  createTechnicalContinuation,
  type ContinuationScope,
  type ContinuationStore,
  type Checkpoint,
} from "./technical-continuation.js";

export async function openTechnicalContinuation(
  scope: ContinuationScope,
  source: NativeModelSource,
  turnId: string,
) {
  type Manifest = {
    schema: 1;
    revision: number;
    owner: string;
    stateHash: string;
    chunks: string[];
  };
  const authority = { assertCurrent: () => source.assertCurrent() };
  const store = await createPluginStateKeyedStoreV2<Manifest>(
    "codex",
    {
      namespace: "technical-continuation",
      retention: "retained",
    },
    authority,
  );
  const chunks = await createPluginStateKeyedStoreV2<{ text: string }>(
    "codex",
    {
      namespace: "technical-continuation-history",
      retention: "retained",
    },
    authority,
  );
  const journal: ContinuationStore = {
    observe: async (key) => {
      if (!store.observe) throw new ContinuationStopped("checkpoint_unavailable");
      const current = await store.observe(key);
      if (!current.value) return { ...current, value: undefined };
      const { chunks: ids, ...manifest } = current.value;
      if (!Array.isArray(ids) || ids.length > 128)
        throw new ContinuationStopped("invalid_checkpoint");
      const parts: string[] = [];
      for (const id of ids) {
        const chunk = await chunks.lookup(id);
        if (!chunk || digest(chunk.text) !== id)
          throw new ContinuationStopped("invalid_checkpoint");
        parts.push(chunk.text);
      }
      let checkpoint: Checkpoint;
      try {
        checkpoint = JSON.parse(parts.join(""));
      } catch {
        throw new ContinuationStopped("invalid_checkpoint");
      }
      if (
        manifest.schema !== 1 ||
        digest(checkpoint) !== manifest.stateHash ||
        checkpoint.revision !== manifest.revision ||
        checkpoint.owner !== manifest.owner
      )
        throw new ContinuationStopped("invalid_checkpoint");
      return { ...current, value: checkpoint };
    },
    compareAndApply: async (key, comparison, intent) => {
      const checkpoint = intent.value;
      const text = JSON.stringify(checkpoint);
      if (text.length > 128 * 160_000) throw new ContinuationStopped("checkpoint_too_large");
      const ids: string[] = [];
      for (let offset = 0; offset < text.length; offset += 160_000) {
        const part = text.slice(offset, offset + 160_000);
        const id = digest(part);
        await chunks.registerIfAbsent(id, { text: part });
        ids.push(id);
      }
      if (!store.compareAndApply) throw new ContinuationStopped("checkpoint_unavailable");
      return store.compareAndApply(key, comparison, {
        operation: "update",
        action: "set",
        value: {
          schema: 1,
          revision: checkpoint.revision,
          owner: checkpoint.owner,
          stateHash: digest(checkpoint),
          chunks: ids,
        },
      });
    },
  };
  const budget = await createPluginStateKeyedStoreV2<{ reservedUsd: number }>(
    "codex",
    {
      namespace: "technical-continuation-budget",
      retention: "retained",
    },
    authority,
  );
  if (!store.observe || !store.compareAndApply || !budget.observe || !budget.compareAndApply)
    throw new ContinuationStopped("checkpoint_unavailable");
  return createTechnicalContinuation({
    scope,
    source,
    turnId,
    store: journal,
    reserveBudget: async (usd) => {
      if (!Number.isFinite(usd) || usd <= 0) throw new ContinuationStopped("budget_unavailable");
      const key = scope.agentId + ":" + new Date().toISOString().slice(0, 10);
      const current = await budget.observe!(key);
      const reservedUsd = (current.value?.reservedUsd ?? 0) + usd;
      if (reservedUsd > Math.min(scope.config.dailyBudgetUsd ?? 10, 10))
        throw new ContinuationStopped("budget_exhausted");
      const applied = await budget.compareAndApply!(key, current.comparison, {
        operation: "update",
        action: "set",
        value: { reservedUsd },
      });
      if (applied.status !== "applied") throw new ContinuationStopped("budget_conflict");
    },
    event: ({ name, data }) => embeddedAgentLog.info(name, data),
  });
}
