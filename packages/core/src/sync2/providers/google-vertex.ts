import { AGENT_POLICY, chatModels } from "../agent.js";
import type { AgentModule } from "../types.js";

export const googleVertex: AgentModule = {
  id: "google-vertex",
  name: "Vertex",
  kind: "agent",
  policy: AGENT_POLICY,
  sources: [
    { url: "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing", what: "Gemini prices: input, output, cached input, long-context rows" },
    { url: "https://cloud.google.com/model-garden/partner-models/pricing", what: "Partner and open model prices: Claude, Grok, Llama, Mistral, DeepSeek, GLM, Qwen, gpt-oss, Kimi" },
    { url: "https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/google-models", what: "Gemini models, with per-model pages for context window and output limits" },
    { url: "https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/partner-models/claude", what: "Claude model IDs, versions and limits" },
    { url: "https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/maas/use-open-models", what: "Open models served as managed APIs (MaaS) and their IDs" },
    { url: "https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/model-versions", what: "Stable versions with release and retirement dates" },
    { url: "https://docs.cloud.google.com/vertex-ai/generative-ai/docs/deprecations", what: "Deprecated and discontinued models and features" },
  ],
  instructions: `Gemini IDs are bare (gemini-2.5-pro, gemini-3.1-pro-preview). Claude IDs carry a version: @default for the current one or @YYYYMMDD for a dated one (claude-opus-4-6@default, claude-sonnet-4-5@20250929). Open models are <publisher>/<model>-maas (deepseek-ai/deepseek-v3.2-maas, zai-org/glm-5-maas, meta/llama-4-scout-17b-16e-instruct-maas); Grok is xai/<model>.
Prices are pay-as-you-go Standard on the global endpoint, USD per million tokens. A price that changes above a prompt length is a band ({ when: { context: { gt: 200000 } }, price }) and the base price is the short-prompt one. When a price is introductory, report the one in effect today and quote its end date.
Mark status "deprecated" when model-versions or deprecations gives a model a retirement or discontinuation date, and quote it.
Skip Priority, Flex and batch prices, provisioned throughput, regional and multi-region surcharges, grounding and tool fees, and image, embedding and TTS models. A model with no file becomes a gap for a person: give base hints such as google/gemini-3.8-flash.`,
  ids: /^(?:[a-z0-9-]+\/)?[a-z0-9][a-z0-9.-]*(?:@(?:default|\d{8}))?$/,
  scope: chatModels,
};
