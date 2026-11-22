import { createHash } from "node:crypto";

export const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export class ContinuationStopped extends Error {
  constructor(readonly reason: string) {
    super(`Model continuation stopped: ${reason}`);
  }
}
