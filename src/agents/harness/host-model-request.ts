import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  acquireSimpleCompletionModelForAgent,
  completeWithPreparedSimpleCompletionModel,
} from "../simple-completion-runtime.js";
import type { AgentHarnessHostCapabilities } from "./host-capability-types.js";

type Source = NonNullable<
  ReturnType<NonNullable<AgentHarnessHostCapabilities["retainSourceAuthority"]>>
>;
type Request = Parameters<NonNullable<Source["completeModelRequest"]>>[0];

/** Preparation, operator model admission and credentials remain host-owned. No tool execution. */
export async function completeHarnessModelRequest(params: {
  cfg: OpenClawConfig;
  agentId: string;
  source: Source;
  request: Request;
}) {
  const { source, request } = params;
  source.assertCurrent();
  request.signal.throwIfAborted();
  const separator = request.model.indexOf("/");
  if (separator <= 0) throw new Error("Continuation requires an exact model reference");
  const execution = source.bindModelExecution?.({
    provider: request.model.slice(0, separator),
    model: request.model.slice(separator + 1),
  });
  if (!execution) throw new Error("Continuation requires original operator model authority");
  try {
    const acquired = await acquireSimpleCompletionModelForAgent({
      cfg: params.cfg,
      agentId: params.agentId,
      modelRef: request.model,
      bindAuthOwner: true,
      skipAgentDiscovery: true,
      signal: request.signal,
    });
    if ("error" in acquired) {
      throw new Error("Continuation model/auth preparation rejected");
    }
    await using prepared = acquired;
    if (
      prepared.selection.provider !== request.model.slice(0, separator) ||
      prepared.selection.modelId !== request.model.slice(separator + 1)
    )
      throw new Error("Continuation model route changed during preparation");
    const assertCurrent = () => {
      source.assertCurrent();
      execution.assertCurrent();
      request.signal.throwIfAborted();
    };
    assertCurrent();
    const cost = prepared.model.cost;
    if (
      !cost ||
      ![cost.input, cost.output, cost.cacheRead, cost.cacheWrite].every(
        (v) => Number.isFinite(v) && v >= 0,
      ) ||
      cost.input <= 0 ||
      cost.output <= 0
    ) {
      throw new Error("Continuation model lacks bounded price metadata");
    }
    // Conservative token ceiling includes structured message/tool framing; never refund an unknown dispatch.
    const inputCeiling = Buffer.byteLength(JSON.stringify(request.context)) * 2 + 16384;
    const upperBoundUsd =
      (inputCeiling * Math.max(cost.input, cost.cacheRead, cost.cacheWrite) +
        request.maxTokens * cost.output) /
      1_000_000;
    await request.reserveBudget(upperBoundUsd);
    assertCurrent();
    const result = await completeWithPreparedSimpleCompletionModel({
      cfg: params.cfg,
      model: prepared.model,
      auth: prepared.auth,
      context: request.context,
      assertCurrent,
      options: {
        signal: AbortSignal.any([request.signal, execution.signal]),
        maxTokens: request.maxTokens,
      },
    });
    assertCurrent();
    return result;
  } finally {
    execution.release();
  }
}
