Nexus Models

Private AI gateway for builders, offering private and confidential AI models through one OpenAI-compatible API.

Provider Details
- API endpoint: https://nexus-api.dappnode.com/v1
- Models endpoint: https://nexus-api.dappnode.com/v1/models
- OpenAI-compatible API
- Environment variable: NEXUS_API_KEY
- Documentation: https://nexus.dappnode.com

Model Categories

Private Models:
- private/* - TEE-backed private models, labeled with " - Private"

Router Models:
- nexus/auto - routes requests to a selected model; pricing depends on the selected model

Other:
- Standard Nexus models use their public catalog IDs

Notes
- Model IDs, limits, pricing, and capabilities are sourced from the Nexus /v1/models catalog
- Supports streaming, tool calls, and structured output when advertised by the catalog
- Nexus advertises private and confidential inference where prompts and data stay private
