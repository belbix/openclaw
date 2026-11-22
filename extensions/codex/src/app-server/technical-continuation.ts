import { randomUUID } from "node:crypto";
import type { NativeModelSource } from "./native-subagent-monitor-types.js";
import type { JsonObject } from "./protocol.js";
import {
  ContinuationStopped,
  digest,
  fallbackContext,
  fallbackResponse,
  responseError,
  snapshotRequest,
  technicalReason,
  pendingResponseCalls,
} from "./technical-continuation-protocol.js";

export type TechnicalContinuationConfig = {
  enabled?: boolean;
  maxTransientRetries?: number;
  maxTechnicalTransitionsPerTurn?: number;
  fallbackModel?: string;
  dailyBudgetUsd?: number;
  maxOutputTokens?: number;
  onUncertainToolState?: "stop";
  onPolicyRefusal?: "checkpoint-and-stop";
};
export type ContinuationDeliveryFacts = {
  source: "delivered" | "missing" | "pending" | "unknown";
  terminal: "delivered" | "missing" | "pending" | "unknown";
};
export type ContinuationScope = {
  agentId: string;
  sessionId: string;
  runId: string;
  /** Distinct native threads never share a checkpoint/CAS head. */
  branchId?: string;
  logicalTurnId?: () => string | undefined;
  observeDeliveries?: () => Promise<ContinuationDeliveryFacts>;
  config: TechnicalContinuationConfig;
  assertCheckpointSafe?: (text: string) => void;
  onEvent?: (event: ContinuationEvent) => void | Promise<void>;
};
export type Checkpoint = {
  schema: 1;
  revision: number;
  sessionId: string;
  runId: string;
  turnId: string;
  logicalTurnId: string;
  owner: string;
  phase: "prepared" | "dispatching" | "completed" | "stopped";
  requestHash: string;
  history: JsonObject;
  integrity: string;
  completed: ReturnType<typeof snapshotRequest>["completed"];
  uncertain: string[];
  /** Aggregate facts from the source owner; never fabricated platform receipts. */
  deliveries: ContinuationDeliveryFacts;
  originalModel: string;
  effectiveModel: string;
  cancelled: boolean;
  retries: number;
  transitions: number;
  attempt: number;
  leaseUntil: number;
  terminalReceipt?: { reason: string; responseHash?: string };
};
export type ContinuationStore = {
  observe(key: string): Promise<{ value: Checkpoint | undefined; comparison: string }>;
  compareAndApply(
    key: string,
    comparison: string,
    intent: { operation: "update"; action: "set"; value: Checkpoint },
  ): Promise<{ status: string }>;
};
export type ContinuationEvent = { name: string; data: Record<string, unknown> };
export type BufferedRequest = {
  body: JsonObject;
  signal: AbortSignal;
  assertCurrent(): void;
  primary(signal: AbortSignal): Promise<Response>;
};
export type BufferedResponse = { status: number; body: Buffer; headers: Record<string, string> };
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
async function readResponse(response: Response, signal: AbortSignal) {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new ContinuationStopped("incomplete_stream");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > MAX_RESPONSE_BYTES) throw new ContinuationStopped("response_too_large");
      chunks.push(Buffer.from(next.value));
    }
    signal.throwIfAborted();
    return Buffer.concat(chunks);
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** No agent loop, tools, messages or stream deltas can escape before terminal CAS. */
export function createTechnicalContinuation(params: {
  scope: ContinuationScope;
  source: NativeModelSource;
  turnId: string;
  store: ContinuationStore;
  reserveBudget: (usd: number) => Promise<void>;
  event?: (event: ContinuationEvent) => void;
}) {
  return async (request: BufferedRequest): Promise<BufferedResponse> => {
    const { scope, store } = params;
    if (!scope.config.enabled) throw new ContinuationStopped("feature_disabled");
    const snapshot = snapshotRequest(request.body);
    scope.assertCheckpointSafe?.(JSON.stringify(snapshot.canonical));
    const logicalTurnId = scope.logicalTurnId?.();
    if (!logicalTurnId) throw new ContinuationStopped("logical_turn_unavailable");
    const key = digest({ agent: scope.agentId, session: scope.sessionId, branch: scope.branchId });
    const observed = await store.observe(key);
    request.assertCurrent();
    request.signal.throwIfAborted();
    const previous = observed.value;
    if (
      previous &&
      (previous.schema !== 1 ||
        previous.integrity !== digest(previous.history) ||
        previous.sessionId !== scope.sessionId ||
        !previous.logicalTurnId)
    )
      throw new ContinuationStopped("invalid_checkpoint");
    const sameTurn = previous?.logicalTurnId === logicalTurnId;
    if (previous?.uncertain.some((id) => !snapshot.completed.some((c) => c.id === id)))
      throw new ContinuationStopped("reconciliation_required");
    // A same-turn abandoned dispatch/delivery may not be stolen. A new admitted user
    // turn may follow a terminal stop, but cannot erase unresolved tool receipts.
    if (
      previous &&
      (previous.phase === "dispatching" ||
        previous.phase === "prepared" ||
        (sameTurn &&
          (previous.phase !== "completed" || previous.requestHash === digest(snapshot.canonical))))
    )
      throw new ContinuationStopped("reconciliation_required");
    const completed = new Map((previous?.completed ?? []).map((c) => [c.id, c]));
    for (const result of snapshot.completed) {
      const prior = completed.get(result.id);
      if (prior && digest(prior) !== digest(result))
        throw new ContinuationStopped("incompatible_tool_receipt");
      completed.set(result.id, result);
    }
    let checkpoint: Checkpoint = {
      schema: 1,
      revision: (previous?.revision ?? 0) + 1,
      sessionId: scope.sessionId,
      runId: scope.runId,
      turnId: params.turnId,
      logicalTurnId,
      owner: randomUUID(),
      phase: "prepared",
      requestHash: digest(snapshot.canonical),
      history: snapshot.canonical,
      integrity: digest(snapshot.canonical),
      completed: [...completed.values()],
      uncertain: snapshot.uncertain,
      deliveries: { source: "unknown", terminal: "unknown" },
      originalModel: (sameTurn ? previous?.originalModel : undefined) ?? String(request.body.model),
      effectiveModel:
        (sameTurn ? previous?.effectiveModel : undefined) ?? String(request.body.model),
      cancelled: false,
      retries: sameTurn ? (previous?.retries ?? 0) : 0,
      transitions: sameTurn ? (previous?.transitions ?? 0) : 0,
      attempt: 0,
      leaseUntil: Date.now() + 600_000,
    };
    let comparison = observed.comparison;
    const emit = async (name: string, reason?: string) => {
      const event = {
        name,
        data: {
          agentId: scope.agentId,
          sessionId: scope.sessionId,
          runId: scope.runId,
          turnId: params.turnId,
          logicalTurnId,
          branchId: scope.branchId,
          revision: checkpoint.revision,
          originalModel: checkpoint.originalModel,
          effectiveModel: checkpoint.effectiveModel,
          reason,
          attempt: checkpoint.attempt,
          completedTools: checkpoint.completed.length,
          uncertainTools: checkpoint.uncertain.length,
        },
      };
      params.event?.(event);
      await scope.onEvent?.(event);
    };
    const commit = async () => {
      const applied = await store.compareAndApply(key, comparison, {
        operation: "update",
        action: "set",
        value: checkpoint,
      });
      if (applied.status !== "applied") throw new ContinuationStopped("continuation_conflict");
      const current = await store.observe(key);
      if (
        current.value?.owner !== checkpoint.owner ||
        current.value.revision !== checkpoint.revision
      )
        throw new ContinuationStopped("continuation_conflict");
      comparison = current.comparison;
    };
    await commit();
    await emit("checkpoint_committed");
    const stop = async (reason: string): Promise<never> => {
      checkpoint = {
        ...checkpoint,
        phase: "stopped",
        revision: checkpoint.revision + 1,
        cancelled: request.signal.aborted,
        terminalReceipt: { reason },
        leaseUntil: 0,
      };
      await commit();
      await emit(
        reason.includes("policy") || reason.includes("cyber")
          ? "policy_refusal_stopped"
          : reason === "reconciliation_required"
            ? "reconciliation_required"
            : "continuation_blocked",
        reason,
      );
      throw new ContinuationStopped(reason);
    };
    if (snapshot.uncertain.length) return stop("reconciliation_required");
    const dispatchFallback = async (
      reason: string,
      transition: boolean,
    ): Promise<BufferedResponse> => {
      if (!scope.config.fallbackModel || !params.source.completeModelRequest)
        return stop("fallback_unavailable");
      const context = fallbackContext(checkpoint.history);
      checkpoint = {
        ...checkpoint,
        transitions: checkpoint.transitions + (transition ? 1 : 0),
        effectiveModel: scope.config.fallbackModel!,
        phase: "prepared",
        revision: checkpoint.revision + 1,
      };
      await commit();
      await emit("continuation_started", reason);
      request.assertCurrent();
      request.signal.throwIfAborted();
      await observeDeliveries();
      const fallbackSignal = AbortSignal.any([request.signal, AbortSignal.timeout(120_000)]);
      const completed = await params.source.completeModelRequest({
        model: scope.config.fallbackModel!,
        context,
        maxTokens: scope.config.maxOutputTokens ?? 8192,
        signal: fallbackSignal,
        reserveBudget: params.reserveBudget,
      });
      fallbackSignal.throwIfAborted();
      request.assertCurrent();
      request.signal.throwIfAborted();
      const body = fallbackResponse(
        completed,
        checkpoint.completed.map((c) => c.id),
        (checkpoint.history.tools ?? []) as JsonObject[],
      );
      checkpoint = {
        ...checkpoint,
        phase: "completed",
        revision: checkpoint.revision + 1,
        leaseUntil: 0,
        terminalReceipt: { reason: "completed", responseHash: digest(body.toString("utf8")) },
        uncertain: pendingResponseCalls(body, checkpoint.completed),
      };
      await commit();
      await emit("continuation_completed");
      return { status: 200, body, headers: { "content-type": "text/event-stream" } };
    };
    const observeDeliveries = async () => {
      let deliveries: ContinuationDeliveryFacts;
      try {
        deliveries = (await scope.observeDeliveries?.()) ?? {
          source: "unknown",
          terminal: "unknown",
        };
      } catch {
        deliveries = { source: "unknown", terminal: "unknown" };
      }
      checkpoint = { ...checkpoint, deliveries, revision: checkpoint.revision + 1 };
      await commit();
      if (
        [deliveries.source, deliveries.terminal].some(
          (state) => !["delivered", "missing"].includes(state),
        )
      )
        return stop("reconciliation_required");
    };
    try {
      await observeDeliveries();
      if (sameTurn && previous?.transitions) {
        if (previous.effectiveModel !== scope.config.fallbackModel)
          return stop("incompatible_checkpoint_route");
        return await dispatchFallback("continuing_effective_model", false);
      }
      while (true) {
        request.assertCurrent();
        request.signal.throwIfAborted();
        checkpoint = {
          ...checkpoint,
          phase: "dispatching",
          revision: checkpoint.revision + 1,
          attempt: checkpoint.attempt + 1,
        };
        await commit();
        let failure: unknown;
        let result: BufferedResponse | undefined;
        const deadline = AbortSignal.timeout(120_000);
        const attemptSignal = AbortSignal.any([request.signal, deadline]);
        try {
          const response = await request.primary(attemptSignal);
          const body = await readResponse(response, attemptSignal);
          failure = responseError(response.status, body);
          if (!failure)
            result = {
              status: response.status,
              body,
              headers: { "content-type": "text/event-stream" },
            };
        } catch (error) {
          failure = deadline.aborted && !request.signal.aborted ? { code: "etimedout" } : error;
        }
        request.assertCurrent();
        request.signal.throwIfAborted();
        if (result) {
          checkpoint = {
            ...checkpoint,
            phase: "completed",
            revision: checkpoint.revision + 1,
            leaseUntil: 0,
            terminalReceipt: {
              reason: "completed",
              responseHash: digest(result.body.toString("utf8")),
            },
            uncertain: pendingResponseCalls(result.body, checkpoint.completed),
          };
          await commit();
          await emit("continuation_completed");
          return result;
        }
        const reason = technicalReason(failure);
        if (!reason) {
          const code =
            typeof failure === "object" && failure !== null && "code" in failure
              ? String(failure.code)
              : failure instanceof ContinuationStopped
                ? failure.reason
                : "unknown_failure";
          return stop(code);
        }
        // A fully buffered failed request produced no downstream tool or delivery action.
        if (checkpoint.retries < Math.min(scope.config.maxTransientRetries ?? 2, 2)) {
          checkpoint = {
            ...checkpoint,
            retries: checkpoint.retries + 1,
            phase: "prepared",
            revision: checkpoint.revision + 1,
          };
          await commit();
          await emit("technical_retry", reason);
          await observeDeliveries();
          continue;
        }
        if (
          !scope.config.fallbackModel ||
          checkpoint.transitions >= Math.min(scope.config.maxTechnicalTransitionsPerTurn ?? 1, 1) ||
          !params.source.completeModelRequest
        )
          return stop("technical_limit_reached");
        return await dispatchFallback(reason, true);
      }
    } catch (error) {
      if (checkpoint.phase === "stopped") throw error;
      return stop(
        request.signal.aborted
          ? "cancelled"
          : error instanceof ContinuationStopped
            ? error.reason
            : "continuation_failed",
      );
    }
  };
}
