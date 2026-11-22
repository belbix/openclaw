import { isJsonObject, type JsonObject } from "./protocol.js";
import { ContinuationStopped, digest } from "./technical-continuation-errors.js";

export function toolNamespace(item: JsonObject): string | undefined {
  if (item.namespace === undefined || item.namespace === null) return undefined;
  if (typeof item.namespace !== "string" || !item.namespace.length)
    throw new ContinuationStopped("incompatible_tool_namespace");
  return item.namespace;
}

/** Provider-safe, injective within the admitted declaration set; native qualification is retained. */
export function toolWireName(item: JsonObject): string {
  if (typeof item.name !== "string" || !item.name.length)
    throw new ContinuationStopped("incompatible_tool_name");
  const namespace = toolNamespace(item);
  return namespace === undefined ? item.name : "ns_" + digest([namespace, item.name]).slice(0, 48);
}

export function continuationToolDeclarations(value: unknown) {
  if (!Array.isArray(value)) throw new ContinuationStopped("incompatible_history");
  const names = new Set<string>();
  const qualified = new Set<string>();
  const result: { native: JsonObject; wireName: string; namespace?: string }[] = [];
  const add = (tool: unknown, namespace?: string) => {
    if (
      !isJsonObject(tool) ||
      !["function", "custom"].includes(String(tool.type)) ||
      (tool.type === "function" && !isJsonObject(tool.parameters)) ||
      tool.namespace !== undefined
    )
      throw new ContinuationStopped("incompatible_history");
    const native = { ...tool, ...(namespace === undefined ? {} : { namespace }) };
    const wireName = toolWireName(native);
    const identity = JSON.stringify([namespace ?? null, tool.name]);
    if (names.has(wireName) || qualified.has(identity))
      throw new ContinuationStopped("ambiguous_tool_declaration");
    names.add(wireName);
    qualified.add(identity);
    result.push({ native, wireName, namespace });
  };
  for (const tool of value) {
    if (!isJsonObject(tool)) throw new ContinuationStopped("incompatible_history");
    if (tool.type !== "namespace") {
      add(tool);
      continue;
    }
    if (typeof tool.name !== "string" || !tool.name.length || !Array.isArray(tool.tools))
      throw new ContinuationStopped("incompatible_history");
    for (const child of tool.tools) add(child, tool.name);
  }
  return result;
}
