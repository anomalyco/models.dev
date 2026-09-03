/** A reasoning model needs researched provider-specific controls. */
export class MissingReasoningOptionsError extends Error {
  constructor(readonly modelId: string, readonly reason: string) {
    super(`${modelId}: ${reason}`);
    this.name = "MissingReasoningOptionsError";
  }
}
