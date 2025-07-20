# Creating OpenModes

Create AI agent modes for OpenCode.

## Structure

Each mode needs 3 files in `modes/your-mode-name/`:

```
modes/your-mode-name/
├── opencode.json         # Configuration
├── your-mode.mode.md     # Main prompt
└── metadata.json         # Info (author, description, date)
```

## Quick Start

**1. Create `metadata.json`:**

```json
{
	"author": "Your Name",
	"description": "What your mode does",
	"date": "2025-01-20"
}
```

**2. Create `opencode.json`:**

```json
{
	"instructions": [],
	"mcp": {},
	"mode": {
		"your-mode-name": {
			"prompt": "{file:./your-mode.mode.md}",
			"tools": {}
		}
	}
}
```

**3. Create `your-mode.mode.md`:**

```markdown
<prompt `your-mode.prompt.md`>

<profile name="Your Mode Name">
You are a specialized AI that [does what].
</profile>

<core_directives>

1. Always [behavior]
2. Never [restriction]
3. Focus on [priority]
   </core_directives>

</prompt>
```

## Adding Tools

**MCP Tools:**

```json
{
	"mcp": {
		"context7": {
			"type": "local",
			"command": ["npx", "-y", "@upstash/context7-mcp"],
			"enabled": true,
			"url": "https://github.com/upstash/context7"
		}
	}
}
```

**Disable Built-ins:**

```json
{
	"mode": {
		"your-mode": {
			"tools": {
				"bash": false,
				"write": false
			}
		}
	}
}
```

## Additional Files

**Instructions:** Create `*.instructions.md` files and reference them:

```json
{
	"instructions": ["./guidelines.instructions.md"]
}
```

**Extra Prompts:** Create `*.prompt.md` files and reference with:

```markdown
<prompt `filename.prompt.md`>
```

## Examples

See `modes/archie/` for a complete example with MCP tools, instructions, and prompt files.

---

That's it! Drop your mode folder in `modes/` and make a pull request.
