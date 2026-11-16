import { AGENT_POLICY, chatModels } from "../agent.js";
import type { AgentModule } from "../types.js";

export const azure: AgentModule = {
  id: "azure",
  name: "Azure",
  kind: "agent",
  policy: AGENT_POLICY,
  sources: [
    { url: "https://azure.microsoft.com/en-us/pricing/details/azure-openai/", what: "Azure OpenAI prices per deployment type: input, cached input, output, long context" },
    { url: "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20%27Foundry%20Models%27%20and%20armRegionName%20eq%20%27eastus2%27", what: "Retail prices API: the meters behind the pricing pages, for OpenAI, Grok, DeepSeek and other models sold by Azure" },
    { url: "https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-sold-directly-by-azure", what: "Models sold directly by Azure: names, context windows, output limits" },
    { url: "https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/claude-models", what: "Claude models on Foundry: IDs, context windows, output limits" },
    { url: "https://platform.claude.com/docs/en/about-claude/pricing", what: "Claude prices on Microsoft Foundry (billed at Anthropic's list prices)" },
    { url: "https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/model-retirements", what: "Azure OpenAI deprecation and retirement dates" },
    { url: "https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/model-retirement-schedule", what: "Retirement schedule for Foundry models, including Claude, DeepSeek and other partners" },
  ],
  instructions: `IDs are the model names Foundry lists, lowercase, with no version date: one file per model (gpt-5.4, gpt-4.1-mini, claude-opus-4-6, deepseek-v3.2, cohere-command-a).
Prices are Global Standard, USD per million tokens. Data Zone and Regional deployments, priority processing and Flex are multipliers the files already hold; don't report them. A price that changes above a prompt length is a band ({ when: { context: { gt: 272000 } }, price }). In the retail prices API, Gl/glbl means Global, ShortCo and LongCo mean up to and above 272K, and older meters are per 1K tokens (multiply by 1,000). Claude prices are the Microsoft Foundry rows of Anthropic's pricing page.
Mark status "deprecated" when the retirement pages give a model a deprecation or retirement date, and quote it.
Skip image, embedding, audio and realtime models, fine-tuning, batch and provisioned throughput. A model with no file becomes a gap for a person: give base hints such as openai/gpt-5.4.`,
  ids: /^[a-z0-9][a-z0-9.-]*$/,
  scope: chatModels,
};
