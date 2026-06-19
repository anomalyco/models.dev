import { createAlibabaProvider } from "./alibaba.js";

const GLOBAL_API_ENDPOINT = "https://dashscope-us.aliyuncs.com/api/v1/models";

export const alibabaGlobal = createAlibabaProvider({
  id: "alibaba-global",
  name: "Alibaba (Global)",
  modelsDir: "providers/alibaba-global/models",
  apiEndpoint: GLOBAL_API_ENDPOINT,
  apiKeyEnv: "DASHSCOPE_GLOBAL_API_KEY",
  deploymentName: "global",
});
