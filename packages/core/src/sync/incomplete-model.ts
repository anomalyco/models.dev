/** A catalog entry needs researched metadata, not a retry of the provider fetch. */
export class IncompleteModelError extends Error {
  constructor(readonly modelId: string, readonly reason: string) {
    super(`${modelId}: ${reason}`);
    this.name = "IncompleteModelError";
  }
}
