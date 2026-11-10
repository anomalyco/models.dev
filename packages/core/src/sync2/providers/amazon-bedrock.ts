import { AGENT_POLICY, chatModels } from "../agent.js";
import type { AgentModule } from "../types.js";

export const amazonBedrock: AgentModule = {
  id: "amazon-bedrock",
  name: "Amazon Bedrock",
  kind: "agent",
  policy: AGENT_POLICY,
  sources: [
    { url: "https://aws.amazon.com/bedrock/pricing/", what: "On-demand prices per model: input, output, cache read and cache write, Global Cross Region and In-Region/Geo rows" },
    { url: "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/us-east-1/index.json", what: "The machine-readable price list behind the pricing page (other regions via current/region_index.json)" },
    { url: "https://docs.aws.amazon.com/bedrock/latest/userguide/models-supported.html", what: "Model IDs, providers and regions" },
    { url: "https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-support.html", what: "Cross-region inference profile IDs (us., eu., apac., au., ca., jp., in., us-gov., global.)" },
    { url: "https://docs.aws.amazon.com/bedrock/latest/userguide/model-cards.html", what: "Model cards: context window and maximum output tokens per model" },
    { url: "https://docs.aws.amazon.com/bedrock/latest/userguide/model-lifecycle.html", what: "Active, Legacy and end-of-life (EOL) dates" },
    { url: "https://docs.aws.amazon.com/bedrock/latest/userguide/model-lifecycle-legacy.html", what: "Lifecycle of models launched before the current policy" },
  ],
  instructions: `IDs are Bedrock model IDs as AWS lists them, and each is its own file. Older dated models end in -v1:0 (anthropic.claude-sonnet-4-5-20250929-v1:0); newer ones have a bare -v1 or no suffix (anthropic.claude-opus-4-6-v1, anthropic.claude-opus-5-5). A cross-region inference profile adds a region prefix (us., eu., apac., au., ca., jp., in., us-gov., global.) and has its own file. Only use profile IDs the inference profile page lists.
Prices are on-demand Standard, USD per million tokens. A global. profile takes the Global Cross Region price; a bare ID or a geo profile (us., eu., jp., ...) takes the In-Region/Geo price, which is higher for Claude 4.5 and later. One cache write price is the 5-minute one; give { "5m": ..., "1h": ... } when both are listed.
Limits come from the model card. Mark status "deprecated" when the lifecycle pages list a model as Legacy or give it an EOL date, and quote the date.
Skip batch, provisioned throughput, priority and flex tiers, and anything priced per image, second or request. A model with no file becomes a gap for a person: give base hints such as anthropic/claude-opus-5-5.`,
  ids: /^(?:(?:us|eu|apac|au|ca|jp|in|us-gov|global)\.)?[a-z0-9-]+\.[a-z0-9][a-z0-9.-]*(?::\d+)?$/,
  scope: chatModels,
};
