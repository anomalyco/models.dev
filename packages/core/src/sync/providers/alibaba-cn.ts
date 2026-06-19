import { createAlibabaProvider } from "./alibaba.js";

const CN_API_ENDPOINT = "https://dashscope.aliyuncs.com/api/v1/models";

export const alibabaCn = createAlibabaProvider({
  id: "alibaba-cn",
  name: "Alibaba (China)",
  modelsDir: "providers/alibaba-cn/models",
  apiEndpoint: CN_API_ENDPOINT,
  apiKeyEnv: "DASHSCOPE_CN_API_KEY",
  deploymentName: "china",
});
