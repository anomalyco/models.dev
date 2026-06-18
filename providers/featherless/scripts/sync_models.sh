#!/usr/bin/env bash
#
# Sync models from Featherless API
#
# Fetches the model list from GET https://api.featherless.ai/v1/models
# and saves the raw response to data/api_response.json for inspection.
#
# Required environment variables:
#   FEATHERLESS_API_KEY - Your Featherless API key
#
# Usage:
#   FEATHERLESS_API_KEY=*** ./sync_models.sh
#

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROVIDER_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
DATA_DIR="${PROVIDER_DIR}/data"
API_RESPONSE_FILE="${DATA_DIR}/api_response.json"

# Validate required environment variables
if [[ -z "${FEATHERLESS_API_KEY:-}" ]]; then
  echo "Error: FEATHERLESS_API_KEY environment variable is required" >&2
  exit 1
fi

API_URL="https://api.featherless.ai/v1/models"

mkdir -p "${DATA_DIR}"

echo "=== Fetching models from Featherless API ==="

RESPONSE=$(curl -s -H "Authorization: Bearer ${FEATHERLESS_API_KEY}" "${API_URL}")

# Check if the response is valid JSON with data
if ! echo "${RESPONSE}" | jq -e '.data' > /dev/null 2>&1; then
  echo "Error: Invalid API response or no data returned" >&2
  echo "Response: ${RESPONSE}" >&2
  exit 1
fi

MODEL_COUNT=$(echo "${RESPONSE}" | jq '.data | length')

if [[ "${MODEL_COUNT}" -eq 0 ]]; then
  echo "Error: No models found in API response" >&2
  exit 1
fi

echo "Found ${MODEL_COUNT} models from API"
echo "${RESPONSE}" | jq '.' > "${API_RESPONSE_FILE}"
echo "Saved API response to ${API_RESPONSE_FILE}"

# Print a summary of served context lengths for each model
echo ""
echo "=== Model context lengths (served) ==="
echo "${RESPONSE}" | jq -r '.data[] | "\(.id)\t\(.context_limit // "unknown")"' | column -t -s $'\t'