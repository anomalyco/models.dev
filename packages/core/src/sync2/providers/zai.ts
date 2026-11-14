import { AGENT_POLICY, chatModels } from "../agent.js";
import type { AgentModule } from "../types.js";

export const zai: AgentModule = {
  id: "zai",
  name: "Z.AI",
  kind: "agent",
  policy: AGENT_POLICY,
  sources: [
    { url: "https://docs.z.ai/guides/overview/pricing", what: "Model prices in USD: input, cached input, output" },
    { url: "https://docs.z.ai/guides/overview/overview", what: "Current models and their context windows" },
    { url: "https://docs.z.ai/guides/llm/glm-5.3", what: "Per-model pages (docs.z.ai/guides/llm/<model> and /guides/vlm/<model>): context window and maximum output" },
    { url: "https://docs.z.ai/guides/vlm/glm-5.3-flash", what: "GLM-5.3-Flash and FlashX: context window and maximum output" },
    { url: "https://docs.z.ai/release-notes/new-released", what: "Model releases and changes" },
  ],
  instructions: `IDs are the lowercase model names the API takes: glm-5.3, glm-5.3-flashx, glm-4.5-air. The docs write them in capitals (GLM-5.3-FlashX); lowercase them.
Prices are USD per million tokens from the pricing page, including its collapsed "Other Pricing" section. "Free" is 0. Cached Input is the cache read price; Cached Input Storage ("Limited-time Free") isn't a price the files hold, so skip it. A price that changes above a prompt length is a band ({ when: { context: { gte: 32000 } }, price }) and the base price is the shorter-prompt row.
Limits come from the overview table and the model pages. Pages round sizes (1M, 200K, 128K); when the file's value rounds to the page's (1M is 1000000 or 1048576, 128K is 128000 or 131072), leave it out. Report a limit only when the file's value doesn't match the page's at all, as a plain token count (200K is 200000).
Mark status "deprecated" when a page says a model is deprecated, retired or being discontinued, and quote it.
Skip image, video, OCR and speech models, agents, built-in tool fees and GLM Coding Plan prices. A model with no file becomes a gap for a person: give base hints such as zhipuai/glm-5.3.`,
  ids: /^[a-z0-9][a-z0-9.-]*$/,
  scope: chatModels,
};
