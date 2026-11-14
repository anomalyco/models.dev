import { AGENT_POLICY, chatModels } from "../agent.js";
import type { AgentModule } from "../types.js";

export const minimax: AgentModule = {
  id: "minimax",
  name: "MiniMax",
  kind: "agent",
  policy: AGENT_POLICY,
  sources: [
    { url: "https://platform.minimax.io/docs/guides/pricing-paygo", what: "Pay-as-you-go LLM prices: input, output and prompt cache read, Standard and Priority tabs, prompt-length tiers" },
    { url: "https://platform.minimax.io/docs/api-reference/text-prompt-caching", what: "Prompt caching: cache read and cache write prices" },
    { url: "https://platform.minimax.io/docs/guides/models-intro", what: "Models and their context windows" },
    { url: "https://platform.minimax.io/docs/guides/text-generation", what: "Text models: IDs, context windows and maximum output" },
    { url: "https://platform.minimax.io/docs/faq/models", what: "Available and retired models, with retirement notices and dates" },
    { url: "https://platform.minimax.io/docs/release-notes/models", what: "Model releases" },
  ],
  instructions: `IDs are the model names the API takes, with their capitals: MiniMax-M3, MiniMax-M3.1-Flash, MiniMax-M2.7-highspeed. A -highspeed model is its own file. Image models (image-01, MiniMax-H3-Image) aren't chat models; skip them, and skip video, speech and music models.
Prices are the Standard tab, USD per million tokens. When the page shows a struck-through list price next to a discounted one ("Permanent 50% off"), report the discounted price in effect. A price that changes above a prompt length is a band: "> 512k input tokens" is { when: { context: { gt: 512000 } }, price }, and the base price is the shorter-prompt row. Priority is a multiplier the files already hold; don't report it.
Pages round sizes (1M, 512K); when the file's limit rounds to the page's (1M is 1000000 or 1048576, 512K is 512000 or 524288), leave it out. Report a limit only when the file's value doesn't match the page's at all.
Mark status "deprecated" when the model list gives a model a retirement date or says it's no longer available to new users, and quote the date.
Skip M Plan, Token Plan and Coding Plan prices, audio packages and tool fees. A model with no file becomes a gap for a person: give base hints such as minimax/MiniMax-M3.`,
  ids: /^[A-Za-z0-9][A-Za-z0-9.-]*$/,
  scope: chatModels,
};
