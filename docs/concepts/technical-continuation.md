---
summary: "Opt-in Codex model-request continuation with durable tool receipts"
read_when:
  - Configuring agent-local recovery after a technical model failure
  - Auditing continuation checkpoints and uncertain tool results
---

# Technical continuation

This experimental Codex capability continues one buffered model request, not the
user run or tool loop. It is disabled by default and selected by exact agent ID
inside `plugins.entries.codex.config.technicalContinuation`.

A selected agent retains the original admitted source authority. Each fallback
request uses normal host model admission, credential preparation and provider
routing. The primary subscription configuration is unchanged. Native WebSocket
sampling is disabled for the selected thread because partial actions cannot be
safely fenced on that transport. The owned relay uses native HTTP 426 negotiation
to select full-history HTTP without overriding reserved built-in providers.

```json5 validate=false
{
  technicalContinuation: {
    "example-agent": {
      enabled: true,
      maxTransientRetries: 2,
      maxTechnicalTransitionsPerTurn: 1,
      fallbackModel: "approved-provider/approved-model",
      dailyBudgetUsd: 10,
      maxOutputTokens: 8192,
      onUncertainToolState: "stop",
      onPolicyRefusal: "checkpoint-and-stop",
    },
  },
}
```

The fallback must be explicitly configured and authorized. A conservative input
and output cost reservation precedes each paid request. Reservations are retained
for the UTC day, including uncertain dispatches, and cannot exceed USD 10 per
agent. This is an additional fail-closed guard, not a replacement for provider or
platform budget enforcement. Unknown prices stop the request.

## Checkpoint and fencing

The plugin state worker owns SQLite persistence. Content-addressed immutable
chunks contain the complete checkpoint; an atomic compare-and-swap head identifies
the only active revision and owner. The checkpoint includes canonical history,
logical turn and session IDs, native thread branch identity, completed tool IDs, argument hashes and saved result
receipts, scheduled calls without results, cancellation, route and attempt limits.
Source-owned aggregate delivery facts are sampled before dispatch. Pending or unknown
delivery custody stops for reconciliation; these facts are not manufactured platform
message receipts. Private reasoning, transport metadata and temporary credentials are excluded.
Registered-secret detection refuses unsafe history before persistence.

A successful response is buffered until its terminal checkpoint commits. Scheduled
tool-call IDs commit before the native consumer can execute them. A following
request must contain their matching results. Duplicate committed calls cannot be
released, even under a new call ID with identical arguments. This deliberately
prefers a stop over uncertain re-execution. The existing `replayInvalid` guard and
whole-run replay classifier are not changed.

Content hashes are durable receipts for the saved tool result, not independent
proof of an external transaction. No exactly-once delivery is promised where the
recipient does not provide receipts or idempotency. Lost results, interrupted
owners, ambiguous response delivery and abandoned dispatches require reconciliation;
a recovery process cannot steal an abandoned lease and replay the run.

## Recovery policy

Only known normalized transient transport, server and rate-limit errors qualify.
An HTTP status alone is insufficient. Each primary or fallback attempt has a two-minute
abortable deadline. A bounded retry uses the same saved request; after the configured
limit, one approved technical transition may occur. Subsequent requests of the
same logical turn retain the effective fallback route without resetting limits.

Policy refusals, including cyber refusals, checkpoint and stop without a new
provider request. The existing cyber escalation route is disabled for opted-in
agents. Authorization, budget, cancellation, unrecognized errors and incompatible
history stop. Unsupported native response actions and provider-specific incremental
history are rejected rather than silently dropped. Only text and function/custom
tool history can cross providers; encrypted reasoning and provider identifiers do not.
Interleaved native system/developer updates retain their text, priority and original
conversation position in a trusted instruction timeline because the portable SDK
has no developer-message variant. User and tool text remain in their data roles
and are never promoted into that timeline.
Native provider-hosted `web_search` and `tool_search` declarations are not portable:
they are excluded from the fallback function catalog with an explicit limitation in
its instructions. The fallback must stop if one is required. History containing an
executed hosted action is still rejected; its result is never discarded or replayed.

Observability events distinguish continuing, stopped and reconciliation-required
states. The ordinary reply handler delivers one sanitized notice per logical-turn
state without retrying unknown notice delivery. Events contain identifiers, revision, route, attempt and tool counts, never
full prompts or credentials. A running local service does not prove model progress.

## Installation and rollback

Preserve the installed package and configuration before installing a reviewed,
tested candidate. Canary in an isolated session with mock providers and temporary
files before enabling one selected agent. Never reset domain services or snapshots
as part of runtime installation. Before resuming domain work, separately verify
its live state, overlay, outstanding operations and external receipts.

Rollback disables the agent flag; if required, restore the previous package and
configuration. Keep the transcript, checkpoint and receipts. An incomplete dispatch
remains blocked pending reconciliation, including after a Gateway restart.
