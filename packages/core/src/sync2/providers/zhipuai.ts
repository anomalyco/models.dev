import { AGENT_POLICY, chatModels } from "../agent.js";
import type { AgentModule } from "../types.js";

// Zhipu prices are in CNY. Each file converts them at a rate it records in its
// header with the CNY list price, which an observation can't update, and a
// daily rate would move every price on every run. So this module only checks
// limits and deprecation; prices stay with the files (Z.AI's USD prices are
// synced through the zai module).
export const zhipuai: AgentModule = {
  id: "zhipuai",
  name: "Zhipu AI",
  kind: "agent",
  policy: {
    ...AGENT_POLICY,
    owns: ["limit.context", "limit.output", { path: "status", merge: "deprecated" }],
  },
  sources: [
    { url: "https://docs.bigmodel.cn/cn/guide/start/model-overview", what: "模型概览: current models with context window (上下文) and maximum output (最大输出)" },
    { url: "https://docs.bigmodel.cn/cn/guide/start/pricing", what: "API 定价: every priced model with its context window (上下文)" },
    { url: "https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3", what: "Per-model pages (docs.bigmodel.cn/cn/guide/models/<kind>/<model>): context window and maximum output" },
    { url: "https://docs.bigmodel.cn/cn/update/new-releases", what: "模型与产品发布记录: model releases, changes and retirements" },
  ],
  instructions: `IDs are the lowercase model names the API takes: glm-5.3, glm-5.3-flashx, glm-4.5-air. The docs write them in capitals (GLM-5.3-FlashX); lowercase them.
Only report limits and deprecation; prices are in CNY and aren't synced here. Pages round sizes (1M, 200K, 128K); when the file's value rounds to the page's (1M is 1000000 or 1048576, 128K is 128000 or 131072), leave it out. Report a limit only when the file's value doesn't match the page's at all, as a plain token count (200K is 200000). 上下文 is the context window and 最大输出 the maximum output.
Mark status "deprecated" when a page says a model is retired, going offline (下线), deprecated (弃用) or no longer available, and quote it with its date.
Skip image, video, OCR, speech and embedding models, agents, tools and GLM Coding Plan pages. A model with no file becomes a gap for a person: give base hints such as zhipuai/glm-5.3.`,
  ids: /^[a-z0-9][a-z0-9.-]*$/,
  scope: chatModels,
};
