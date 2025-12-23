#!/usr/bin/env bash
#
# Generate/update model_names.json for Cloudflare AI Gateway
#
# This script reads the API response from data/api_response.json and adds
# any new model IDs to model_names.json with the ID as a placeholder value.
# Existing entries are preserved.
#
# Usage:
#   ./generate_model_names.sh
#

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROVIDER_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
source "${SCRIPT_DIR}/utils.sh"

# =============================================================================
# Step 2: Update model names
# =============================================================================

echo ""
echo "=== Step 2: Generating / adding missing model names ==="

# =============================================================================
# Main script
# =============================================================================

DATA_DIR="${PROVIDER_DIR}/data"
MODEL_NAMES_FILE="${DATA_DIR}/model_names.json"
API_RESPONSE_FILE="${DATA_DIR}/api_response.json"

# Check if API response file exists
if [[ ! -f "${API_RESPONSE_FILE}" ]]; then
  echo "Error: API response file not found at ${API_RESPONSE_FILE}" >&2
  echo "Run generate_models.sh first to fetch the API response." >&2
  exit 1
fi

# Check if the response is valid JSON with data
if ! jq -e '.data' "${API_RESPONSE_FILE}" > /dev/null 2>&1; then
  echo "Error: Invalid API response or no data in ${API_RESPONSE_FILE}" >&2
  exit 1
fi

MODEL_COUNT=$(jq '.data | length' "${API_RESPONSE_FILE}")

if [[ "${MODEL_COUNT}" -eq 0 ]]; then
  echo "Error: No models found in API response" >&2
  exit 1
fi

echo "Found ${MODEL_COUNT} models in API response"

# Initialize model_names.json if it doesn't exist
if [[ ! -f "${MODEL_NAMES_FILE}" ]]; then
  echo "{}" > "${MODEL_NAMES_FILE}"
fi

ADDED_COUNT=0
SKIPPED_COUNT=0

# Process each model from the API response
while IFS= read -r MODEL_JSON; do
  MODEL_ID=$(echo "${MODEL_JSON}" | jq -r '.id')
  
  # Skip empty IDs
  [[ -z "${MODEL_ID}" || "${MODEL_ID}" == "null" ]] && continue
  
  # Check if this model should be included
  if ! should_include_model "${MODEL_ID}"; then
    echo "Skipping: ${MODEL_ID} (not in include list)"
    ((SKIPPED_COUNT++)) || true
    continue
  fi
  
  # Check if model already exists in model_names.json
  EXISTING=$(jq -r --arg id "${MODEL_ID}" '.[$id] // empty' "${MODEL_NAMES_FILE}")
  
  if [[ -z "${EXISTING}" ]]; then
    # Add model ID to model_names.json with ID as placeholder
    echo "Adding: ${MODEL_ID}"
    TMP_FILE=$(mktemp)
    jq --arg id "${MODEL_ID}" '.[$id] = $id' "${MODEL_NAMES_FILE}" > "${TMP_FILE}"
    mv "${TMP_FILE}" "${MODEL_NAMES_FILE}"
    ((ADDED_COUNT++)) || true
  else
    echo "Already exists: ${MODEL_ID}"
  fi
done < <(jq -c '.data[]' "${API_RESPONSE_FILE}")

TOTAL_COUNT=$(jq 'length' "${MODEL_NAMES_FILE}")

echo ""
echo "Summary:"
echo "  Models in API: ${MODEL_COUNT}"
echo "  Models skipped: ${SKIPPED_COUNT}"
echo "  New entries added: ${ADDED_COUNT}"
echo "  Total entries in model_names.json: ${TOTAL_COUNT}"
echo ""
echo "Done! Review model_names.json and update placeholder values with human-readable names."
