export type Row = {
  providerId: string;
  providerName: string;
  modelId: string;
  name: string;
  family?: string;
  reasoning: boolean;
  tool_call: boolean;
  attachment: boolean;
  temperature?: boolean;
  structured_output?: boolean;
  open_weights: boolean;
  modalities: { input: string[]; output: string[] };
  cost?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache_read?: number;
    cache_write?: number;
    input_audio?: number;
    output_audio?: number;
  };
  limit: { context: number; input?: number; output: number };
  knowledge?: string;
  release_date?: string;
  last_updated?: string;
};

type ApiJson = Record<string, { name: string; models: Record<string, any> }>;

export function flattenProviders(api: ApiJson): Row[] {
  const rows: Row[] = [];
  for (const [providerId, provider] of Object.entries(api)) {
    for (const [modelId, model] of Object.entries(provider.models)) {
      if (model.status === "alpha") continue;
      rows.push({
        providerId, providerName: provider.name, modelId,
        name: model.name, family: model.family,
        reasoning: model.reasoning, tool_call: model.tool_call,
        attachment: model.attachment, temperature: model.temperature,
        structured_output: model.structured_output,
        open_weights: model.open_weights, modalities: model.modalities,
        cost: model.cost, limit: model.limit, knowledge: model.knowledge,
        release_date: model.release_date, last_updated: model.last_updated,
      });
    }
  }
  // Sort by provider name, then model name (same as production)
  rows.sort((a, b) => a.providerName.localeCompare(b.providerName) || a.name.localeCompare(b.name));
  return rows;
}
