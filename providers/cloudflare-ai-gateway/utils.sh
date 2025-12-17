# Shared utilities for Cloudflare AI Gateway scripts
# Source this file: source "$(dirname "${BASH_SOURCE[0]}")/utils.sh"

# =============================================================================
# CONFIGURATION: Providers and models to include
# =============================================================================

# Providers to include ALL models from (generated with defaults)
INCLUDE_ALL_PROVIDERS="workers-ai replicate"

# Namespaces to skip entirely (provider/namespace format)
SKIP_NAMESPACES="replicate/replicate-internal"

# Providers to cross-reference from source provider files
CROSS_REFERENCE_PROVIDERS="openai anthropic"

# For cross-referenced providers, only include these well-known models (regex patterns)
# Format: "provider/model-pattern"
# Use $ anchor for exact matches to avoid dated versions and variants
WELL_KNOWN_MODELS=(
  # OpenAI - canonical names only, no dated versions
  # Note: dots must be escaped as \. to avoid matching dashes
  "openai/gpt-5\\.1$"
  "openai/gpt-5\\.1-codex$"
  "openai/gpt-4o$"
  "openai/gpt-4o-mini$"
  "openai/gpt-4-turbo$"
  "openai/gpt-4$"
  "openai/gpt-3\\.5-turbo$"
  "openai/o1$"
  "openai/o1-mini$"
  "openai/o1-preview$"
  "openai/o3$"
  "openai/o3-mini$"
  "openai/o3-pro$"
  "openai/o4-mini$"
  
  # Anthropic - canonical names only, no dated versions or duplicates
  # Note: dots must be escaped as \. to avoid matching dashes
  "anthropic/claude-sonnet-4\\.5$"
  "anthropic/claude-opus-4\\.5$"
  "anthropic/claude-haiku-4\\.5$"
  "anthropic/claude-opus-4\\.1$"
  "anthropic/claude-sonnet-4$"
  "anthropic/claude-opus-4$"
  "anthropic/claude-3\\.5-sonnet$"
  "anthropic/claude-3\\.5-haiku$"
  "anthropic/claude-3-opus$"
  "anthropic/claude-3-sonnet$"
  "anthropic/claude-3-haiku$"
)

# =============================================================================
# Helper function to get mapped model name for source file lookup
# =============================================================================
get_mapped_name() {
  local model_name="$1"
  case "${model_name}" in
    # Anthropic mappings (Cloudflare uses dots, source uses dashes)
    "claude-sonnet-4.5") echo "claude-sonnet-4-5" ;;
    "claude-opus-4.5") echo "claude-opus-4-5" ;;
    "claude-haiku-4.5") echo "claude-haiku-4-5" ;;
    "claude-opus-4.1") echo "claude-opus-4-1" ;;
    "claude-sonnet-4") echo "claude-sonnet-4-0" ;;
    "claude-opus-4") echo "claude-opus-4-0" ;;
    "claude-3.5-sonnet") echo "claude-3-5-sonnet-20241022" ;;
    "claude-3.5-haiku") echo "claude-3-5-haiku-latest" ;;
    "claude-3-opus") echo "claude-3-opus-20240229" ;;
    "claude-3-sonnet") echo "claude-3-sonnet-20240229" ;;
    "claude-3-haiku") echo "claude-3-haiku-20240307" ;;
    *) echo "${model_name}" ;;
  esac
}

# =============================================================================
# Helper function to check if a model should be included
# =============================================================================
should_include_model() {
  local model_id="$1"
  local provider
  
  # Extract provider from model ID (first path segment)
  provider=$(echo "${model_id}" | cut -d'/' -f1)
  
  # Check if model is in a skipped namespace
  for ns in ${SKIP_NAMESPACES}; do
    if [[ "${model_id}" == ${ns}/* ]]; then
      return 1  # Exclude
    fi
  done
  
  # Check if provider is in the "include all" list
  for p in ${INCLUDE_ALL_PROVIDERS}; do
    if [[ "${provider}" == "${p}" ]]; then
      return 0  # Include
    fi
  done
  
  # Check if model matches any well-known pattern
  for pattern in "${WELL_KNOWN_MODELS[@]}"; do
    if echo "${model_id}" | grep -qE "^${pattern}"; then
      return 0  # Include
    fi
  done
  
  return 1  # Exclude
}

# =============================================================================
# Helper function to find source file for cross-referenced models
# =============================================================================
find_source_file() {
  local provider="$1"
  local model_name="$2"
  local providers_dir="$3"
  
  # Check if provider is in cross-reference list
  local is_cross_ref=false
  for p in ${CROSS_REFERENCE_PROVIDERS}; do
    if [[ "${provider}" == "${p}" ]]; then
      is_cross_ref=true
      break
    fi
  done
  
  if [[ "${is_cross_ref}" != "true" ]]; then
    return 1
  fi
  
  # Get mapped name
  local mapped_name
  mapped_name=$(get_mapped_name "${model_name}")
  
  local source_file="${providers_dir}/${provider}/models/${mapped_name}.toml"
  
  if [[ -f "${source_file}" ]]; then
    echo "${source_file}"
    return 0
  fi
  
  # Try original name if mapping didn't work
  if [[ "${mapped_name}" != "${model_name}" ]]; then
    source_file="${providers_dir}/${provider}/models/${model_name}.toml"
    if [[ -f "${source_file}" ]]; then
      echo "${source_file}"
      return 0
    fi
  fi
  
  return 1
}
