#!/usr/bin/env bash
#
# Generate model TOML files for Cloudflare AI Gateway
#
# This script runs the generation pipeline:
#   1. Fetch models from Cloudflare AI Gateway API
#   2. generate_model_names.sh - Updates model_names.json with new model IDs
#   3. generate_model_toml.sh - Generates TOML files for each model
#
# Required environment variables:
#   CLOUDFLARE_API_TOKEN  - Your Cloudflare API token
#   CLOUDFLARE_ACCOUNT_ID - Your Cloudflare account ID
#   CLOUDFLARE_GATEWAY_ID - Your AI Gateway name/ID
#
# Usage:
#   CLOUDFLARE_API_TOKEN=xxx CLOUDFLARE_ACCOUNT_ID=xxx CLOUDFLARE_GATEWAY_ID=xxx ./generate_models.sh
#

set -eo pipefail

# =============================================================================
# Step 1: Fetch models from Cloudflare AI Gateway
# =============================================================================

echo "=== Step 1: Fetching models from Cloudflare AI Gateway ==="

# =============================================================================
# Main script
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROVIDER_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
DATA_DIR="${PROVIDER_DIR}/data"
API_RESPONSE_FILE="${DATA_DIR}/api_response.json"

# Validate required environment variables
if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  echo "Error: CLOUDFLARE_API_TOKEN environment variable is required" >&2
  exit 1
fi

if [[ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]]; then
  echo "Error: CLOUDFLARE_ACCOUNT_ID environment variable is required" >&2
  exit 1
fi

if [[ -z "${CLOUDFLARE_GATEWAY_ID:-}" ]]; then
  echo "Error: CLOUDFLARE_GATEWAY_ID environment variable is required" >&2
  exit 1
fi

API_URL="https://gateway.ai.cloudflare.com/v1/${CLOUDFLARE_ACCOUNT_ID}/${CLOUDFLARE_GATEWAY_ID}/compat/models"

mkdir -p "${DATA_DIR}"
RESPONSE=$(curl -s -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" "${API_URL}")

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
echo "${RESPONSE}" > "${API_RESPONSE_FILE}"
echo "Saved API response to ${API_RESPONSE_FILE}"