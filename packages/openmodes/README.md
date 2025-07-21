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
	"date": "2025-01-20",
	"version": "0.1.0",
	"pr_number": 123
}
```

**Fields:**

- `author`: Your name or GitHub username
- `description`: Brief description of what your mode does
- `date`: Last updated date (YYYY-MM-DD format)
- `version`: Semantic version of your mode (e.g., "0.1.0")
- `pr_number`: (Optional) PR number where this mode was introduced

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

## API

The OpenModes database provides a REST API to access mode data programmatically.

### Endpoints

**Get all modes (basic info only):**

```bash
GET /mode/index
```

Returns: `{ id, author, description, votes, downloads, updated_at, version, pr_number? }`

**Get all modes (full data):**

```bash
GET /mode/all
```

Returns: Complete mode data including prompts, tools, and context instructions

**Get specific mode:**

```bash
GET /mode/{mode-id}
```

Returns: Full data for a single mode

**Example:**

```bash
curl https://openmodes.dev/mode/index
curl https://openmodes.dev/mode/archie
```

### Response Format

**Index endpoint (`/mode/index`):**

```json
{
	"archie": {
		"id": "archie",
		"author": "spoon",
		"description": "Architectural guidance mode...",
		"votes": 5,
		"downloads": 25,
		"updated_at": "2025-01-20",
		"version": "0.1.0",
		"pr_number": 123
	}
}
```

**Full mode endpoint (`/mode/{id}` or `/mode/all`):**

```json
{
	"id": "archie",
	"author": "spoon",
	"description": "Architectural guidance mode...",
	"votes": 5,
	"downloads": 25,
	"updated_at": "2025-01-20",
	"version": "0.1.0",
	"pr_number": 123,
	"opencode_config": {
		"instructions": ["./adr.instructions.md"],
		"mcp": {
			"context7": {
				"type": "local",
				"command": ["npx", "-y", "@upstash/context7-mcp"],
				"enabled": true,
				"url": "https://github.com/upstash/context7" // for user verification purposes
			}
		},
		"mode": {
			"test": {
				"prompt": "{file:./archie.mode.md}",
				"tools": {
					"bash": false
				}
			}
		}
	},
	"mode_prompt": "Your complete system prompt...",
	"context_instructions": [{ "title": "ADR Guidelines", "content": "..." }]
}
```

---

That's it! Drop your mode folder in `modes/` and make a pull request.
