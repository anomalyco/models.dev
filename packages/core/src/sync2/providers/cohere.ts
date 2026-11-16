import { AGENT_POLICY, chatModels } from "../agent.js";
import type { AgentModule } from "../types.js";

export const cohere: AgentModule = {
  id: "cohere",
  name: "Cohere",
  kind: "agent",
  policy: AGENT_POLICY,
  sources: [
    { url: "https://cohere.com/pricing", what: "Prices per model: input and output per 1M tokens (also in the page's embedded pricingRows data), and legacy model prices in the FAQ" },
    { url: "https://docs.cohere.com/docs/models", what: "Model IDs, context windows, maximum output tokens and status" },
    { url: "https://docs.cohere.com/docs/deprecations", what: "Deprecated and shut-down models with their dates and replacements" },
  ],
  instructions: `IDs are the model names the API takes, with the version date: command-a-03-2025, command-a-reasoning-08-2025, command-r-plus-08-2024, c4ai-aya-expanse-32b. Each is its own file.
Prices are USD per million tokens. The pricing page names models by display name (Command A, Command R+ 08-2024, Aya Expanse); match each to its ID through the models page, and only report a price the page ties to one model. Pages round sizes (256K, 128K); when the file's limit rounds to the page's (128K is 128000 or 131072), leave it out. Report a limit only when the file's value doesn't match the page's at all.
Mark status "deprecated" when the deprecations page lists a model as Deprecated or gives it a shutdown date, and quote it. Legacy alone (no more updates) isn't deprecated.
Skip embed, rerank, transcribe and fine-tuning prices, and Model Vault or private deployment pricing. A model with no file becomes a gap for a person: give base hints such as cohere/command-a-03-2025.`,
  ids: /^[a-z0-9][a-z0-9.-]*$/,
  scope: chatModels,
};
