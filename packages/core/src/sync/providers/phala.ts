import { createAciCatalogProvider } from "./aci.js";

export const phala = createAciCatalogProvider({
  id: "phala",
  name: "Phala Cloud",
  modelsDir: "providers/phala/models",
  chatEndpoint: "https://inference.phala.com/v1/models",
  embeddingEndpoint: "https://inference.phala.com/v1/embeddings/models",
});
