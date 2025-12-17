#!/usr/bin/env bash
#
# Generate model TOML files for Cloudflare AI Gateway
#
# This script reads the API response from data/api_response.json and generates
# TOML files for each model.
#
# Usage:
#   ./generate_model_toml.sh
#

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/utils.sh"

# =============================================================================
# Main script
# =============================================================================
MODELS_DIR="${SCRIPT_DIR}/models"
DATA_DIR="${SCRIPT_DIR}/data"
PROVIDERS_DIR="${SCRIPT_DIR}/../.."
MODEL_NAMES_FILE="${SCRIPT_DIR}/model_names.json"
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

# Create a temporary file to track API model files
API_MODEL_FILES=$(mktemp)
trap "rm -f ${API_MODEL_FILES}" EXIT

GENERATED_COUNT=0
SKIPPED_COUNT=0
CROSS_REF_COUNT=0

# Process each model from the API response
while IFS= read -r MODEL_JSON; do
  MODEL_ID=$(echo "${MODEL_JSON}" | jq -r '.id')
  COST_IN=$(echo "${MODEL_JSON}" | jq -r '.cost_in // 0')
  COST_OUT=$(echo "${MODEL_JSON}" | jq -r '.cost_out // 0')
  CREATED_AT=$(echo "${MODEL_JSON}" | jq -r '.created_at // 0')
  
  # Skip empty IDs
  [[ -z "${MODEL_ID}" || "${MODEL_ID}" == "null" ]] && continue
  
  # Check if this model should be included
  if ! should_include_model "${MODEL_ID}"; then
    ((SKIPPED_COUNT++)) || true
    continue
  fi
  
  ((INCLUDED_COUNT++)) || true
  
  # Extract provider and model name
  PROVIDER=$(echo "${MODEL_ID}" | cut -d'/' -f1)
  MODEL_NAME=$(echo "${MODEL_ID}" | cut -d'/' -f2-)
  
  # Convert model ID to file path based on the API format:
  # - "workers-ai/@cf/vendor/model-name" -> "workers-ai/model-name.toml"
  # - "anthropic/claude-opus-4-5" -> "anthropic/claude-opus-4-5.toml"
  # - "replicate/meta/llama-3" -> "replicate/meta/llama-3.toml"
  
  if [[ "${MODEL_ID}" == workers-ai/@cf/* ]]; then
    # Workers AI model: workers-ai/@cf/vendor/model-name -> workers-ai/model-name.toml
    MODEL_NAME=$(echo "${MODEL_ID}" | sed 's|workers-ai/@cf/[^/]*/||')
    MODEL_PATH="workers-ai/${MODEL_NAME}.toml"
  else
    # All other models: keep the path structure as-is
    MODEL_PATH="${MODEL_ID}.toml"
  fi
  
  FULL_PATH="${MODELS_DIR}/${MODEL_PATH}"
  echo "${FULL_PATH}" >> "${API_MODEL_FILES}"
  
  # Create directory if needed
  MODEL_DIR=$(dirname "${FULL_PATH}")
  mkdir -p "${MODEL_DIR}"
  
  # Check if we should cross-reference from source provider
  SOURCE_FILE=$(find_source_file "${PROVIDER}" "${MODEL_NAME}" "${PROVIDERS_DIR}" || true)
  
  if [[ -n "${SOURCE_FILE}" && -f "${SOURCE_FILE}" ]]; then
    echo "Cross-referencing: ${MODEL_PATH} <- ${SOURCE_FILE#${PROVIDERS_DIR}/}"
    cp "${SOURCE_FILE}" "${FULL_PATH}"
    ((CROSS_REF_COUNT++)) || true
  else
    # Generate file with defaults for workers-ai, replicate, etc.
    echo "Generating: ${MODEL_PATH}"
    ((GENERATED_COUNT++)) || true
    
    # Get display name from mapping file, or add model ID to file and use as-is
    DISPLAY_NAME=$(jq -r --arg id "${MODEL_ID}" '.[$id] // empty' "${MODEL_NAMES_FILE}")
    if [[ -z "${DISPLAY_NAME}" ]]; then
      # Add model ID to model_names.json with ID as placeholder
      TMP_FILE=$(mktemp)
      jq --arg id "${MODEL_ID}" '.[$id] = $id' "${MODEL_NAMES_FILE}" > "${TMP_FILE}"
      mv "${TMP_FILE}" "${MODEL_NAMES_FILE}"
      DISPLAY_NAME="${MODEL_ID}"
    fi
    # Escape double quotes for TOML string
    DISPLAY_NAME="${DISPLAY_NAME//\"/\\\"}"
    
    # Convert created_at timestamp to date (YYYY-MM-DD)
    if [[ "${CREATED_AT}" != "0" && "${CREATED_AT}" != "null" ]]; then
      RELEASE_DATE=$(date -r "${CREATED_AT}" +%Y-%m-%d 2>/dev/null || date -d "@${CREATED_AT}" +%Y-%m-%d 2>/dev/null || date +%Y-%m-%d)
    else
      RELEASE_DATE=$(date +%Y-%m-%d)
    fi
    
    # Convert cost per token to cost per million tokens
    # API returns cost per token, we need cost per 1M tokens
    # Treat negative or invalid costs as 0
    if [[ "${COST_IN}" != "0" && "${COST_IN}" != "null" ]]; then
      COST_IN_PER_M=$(echo "${COST_IN} * 1000000" | bc -l | sed 's/^\./0./' | sed 's/0*$//' | sed 's/\.$//')
      # If negative, set to 0
      if (( $(echo "${COST_IN_PER_M} < 0" | bc -l) )); then
        COST_IN_PER_M="0"
      fi
    else
      COST_IN_PER_M="0"
    fi
    
    if [[ "${COST_OUT}" != "0" && "${COST_OUT}" != "null" ]]; then
      COST_OUT_PER_M=$(echo "${COST_OUT} * 1000000" | bc -l | sed 's/^\./0./' | sed 's/0*$//' | sed 's/\.$//')
      # If negative, set to 0
      if (( $(echo "${COST_OUT_PER_M} < 0" | bc -l) )); then
        COST_OUT_PER_M="0"
      fi
    else
      COST_OUT_PER_M="0"
    fi
    
    # Always overwrite to ensure data is up to date
    cat > "${FULL_PATH}" << EOF
name = "${DISPLAY_NAME}"
release_date = "${RELEASE_DATE}"
last_updated = "${RELEASE_DATE}"
attachment = false
reasoning = false
temperature = true
tool_call = false
open_weights = false

[cost]
input = ${COST_IN_PER_M}
output = ${COST_OUT_PER_M}

[limit]
context = 128000
output = 16384

[modalities]
input = ["text"]
output = ["text"]
EOF
  fi
done < <(jq -c '.data[]' "${API_RESPONSE_FILE}")

# Find and remove models that are not in the API response
echo ""
echo "Checking for models to remove..."
REMOVED_COUNT=0

# Find all existing .toml files in models directory
while IFS= read -r -d '' EXISTING_FILE; do
  if ! grep -qxF "${EXISTING_FILE}" "${API_MODEL_FILES}"; then
    REL_PATH="${EXISTING_FILE#${MODELS_DIR}/}"
    echo "Removing model not in API: ${REL_PATH}"
    rm -f "${EXISTING_FILE}"
    ((REMOVED_COUNT++)) || true
  fi
done < <(find "${MODELS_DIR}" -name "*.toml" -type f -print0)

# Clean up empty directories
find "${MODELS_DIR}" -type d -empty -delete 2>/dev/null || true

FINAL_COUNT=$(find "${MODELS_DIR}" -name "*.toml" -type f | wc -l | tr -d ' ')

echo ""
echo "Summary:"
echo "  Models from API: ${MODEL_COUNT}"
echo "  Models skipped (filtered): ${SKIPPED_COUNT}"
echo "  Models cross-referenced: ${CROSS_REF_COUNT}"
echo "  Models generated: ${GENERATED_COUNT}"
echo "  Models removed: ${REMOVED_COUNT}"
echo "  Total models: ${FINAL_COUNT}"
echo ""
echo "Done!"
