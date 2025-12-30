#!/usr/bin/env python3
"""
Generate TOML model files for Parasail from parasail.json API data.

Usage:
    python generate_parasail_models.py parasail.json models/
    python generate_parasail_models.py --input parasail.json --output models/
"""

import argparse
import json
import re
from datetime import date
from pathlib import Path


def sanitize_filename(name: str) -> str:
    """Convert model name to a valid filename."""
    # Use deploymentName-style naming from externalAlias (strip parasail- prefix)
    name = name.replace("parasail-", "")
    # Replace invalid chars
    name = re.sub(r'[^\w\-.]', '-', name)
    # Collapse multiple dashes
    name = re.sub(r'-+', '-', name)
    return name.lower().strip('-')


def format_number(n: int) -> str:
    """Format large numbers with underscores for TOML readability."""
    if n >= 1000:
        return f"{n:_}"
    return str(n)


def infer_modalities(model: dict) -> tuple[list[str], list[str]]:
    """Infer input/output modalities from model info."""
    model_name = model.get("modelName", "").lower()
    display_name = model.get("displayName", "").lower()
    engine_task = model.get("engineTask", "")
    
    input_mods = ["text"]
    output_mods = ["text"]
    
    # Vision models
    if any(x in model_name or x in display_name for x in ["vl", "vision", "molmo", "ocr", "ui-tars", "glm-4.6v"]):
        input_mods.append("image")
    
    # Audio models (whisper is STT)
    if "whisper" in model_name.lower():
        input_mods = ["audio"]
        output_mods = ["text"]
    
    # TTS models
    if "tts" in model.get("externalAlias", "").lower() or model.get("ttsCost"):
        input_mods = ["text"]
        output_mods = ["audio"]
    
    return input_mods, output_mods


def infer_reasoning(model: dict) -> bool:
    """Infer if model supports reasoning/chain-of-thought."""
    model_name = model.get("modelName", "").lower()
    display_name = model.get("displayName", "").lower()
    
    reasoning_keywords = ["think", "reasoning", "r1"]
    return any(kw in model_name or kw in display_name for kw in reasoning_keywords)


def infer_tool_call(model: dict) -> bool:
    """Infer if model likely supports tool calling."""
    model_name = model.get("modelName", "").lower()
    
    # Most instruct models support tool calling
    # OCR/TTS/STT models typically don't
    if any(x in model_name for x in ["ocr", "whisper", "tts", "orpheus"]):
        return False
    
    # Major models that support tool calling
    if any(x in model_name for x in ["llama", "qwen", "mistral", "deepseek", "kimi", "glm", "gemma"]):
        return True
    
    return False


def generate_toml(model: dict) -> str:
    """Generate TOML content for a model."""
    lines = []
    
    # Name - clean up the display name
    display_name = model.get("displayName", "")
    # Remove org prefix if present (e.g., "openai/gpt-oss-20b" -> "GPT-OSS-20B")
    if "/" in display_name:
        display_name = display_name.split("/")[-1]
    lines.append(f'name = "{display_name}"')
    
    # Dates - use today as placeholder since API doesn't provide
    today = date.today().strftime("%Y-%m-%d")
    lines.append(f'release_date = "{today}"')
    lines.append(f'last_updated = "{today}"')
    
    # Capabilities
    input_mods, output_mods = infer_modalities(model)
    has_attachment = "image" in input_mods or "pdf" in input_mods
    lines.append(f'attachment = {str(has_attachment).lower()}')
    lines.append(f'reasoning = {str(infer_reasoning(model)).lower()}')
    lines.append('temperature = true')
    lines.append(f'tool_call = {str(infer_tool_call(model)).lower()}')
    lines.append('open_weights = true')  # Most parasail models are open weights
    
    # Cost section
    input_cost = model.get("inputCost")
    output_cost = model.get("outputCost")
    
    if input_cost is not None or output_cost is not None:
        lines.append('')
        lines.append('[cost]')
        if input_cost is not None:
            lines.append(f'input = {input_cost}')
        if output_cost is not None:
            lines.append(f'output = {output_cost}')
    
    # Limit section
    context_length = model.get("contextLength")
    max_completion = model.get("maxCompletionTokens")
    
    if context_length or max_completion:
        lines.append('')
        lines.append('[limit]')
        if context_length:
            lines.append(f'context = {format_number(context_length)}')
        if max_completion:
            lines.append(f'output = {format_number(max_completion)}')
    
    # Modalities section
    lines.append('')
    lines.append('[modalities]')
    lines.append(f'input = {json.dumps(input_mods)}')
    lines.append(f'output = {json.dumps(output_mods)}')
    
    return '\n'.join(lines) + '\n'


def main():
    parser = argparse.ArgumentParser(
        description="Generate TOML model files for Parasail from API JSON data."
    )
    parser.add_argument(
        "input",
        nargs="?",
        default="parasail.json",
        help="Input JSON file from Parasail API (default: parasail.json)",
    )
    parser.add_argument(
        "output",
        nargs="?",
        default="models",
        help="Output directory for TOML files (default: models/)",
    )
    parser.add_argument(
        "-i", "--input",
        dest="input_file",
        help="Input JSON file (alternative to positional arg)",
    )
    parser.add_argument(
        "-o", "--output",
        dest="output_dir",
        help="Output directory (alternative to positional arg)",
    )
    args = parser.parse_args()

    input_file = Path(args.input_file or args.input)
    output_dir = Path(args.output_dir or args.output)

    # Load API data
    with open(input_file, 'r') as f:
        models = json.load(f)
    
    # Ensure output directory exists
    output_dir.mkdir(parents=True, exist_ok=True)
    
    # Track generated files
    generated = []
    skipped = []
    
    for model in models:
        external_alias = model.get("externalAlias", "")
        if not external_alias:
            skipped.append(model.get("displayName", "unknown"))
            continue
        
        # Skip audio-only models that don't fit the text model schema well
        engine_task = model.get("engineTask", "")
        if engine_task not in ["GENERATE", ""]:
            # Could be TTS, STT, etc.
            pass
        
        # Generate filename from external alias
        filename = sanitize_filename(external_alias) + ".toml"
        filepath = output_dir / filename
        
        # Generate TOML content
        toml_content = generate_toml(model)
        
        # Write file
        with open(filepath, 'w') as f:
            f.write(toml_content)
        
        generated.append(filename)
        print(f"Generated: {filepath}")
    
    print(f"\n✓ Generated {len(generated)} model files in {output_dir}")
    if skipped:
        print(f"⚠ Skipped {len(skipped)} models without external alias: {skipped}")


if __name__ == "__main__":
    main()
