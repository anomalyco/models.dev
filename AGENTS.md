# AGENTS Configuration

## Commands

- Install dependencies: `bun install`
- Dev server: `bun run --cwd packages/web dev`
- Build: `bun run --cwd packages/web build`
- Validate schema: `./script/validate.ts`
- RSS feed update: `./script/rss.ts`
- Single test: (no tests in this repo)

## Code Style

- ESM modules (`type: module`), explicit `.js` imports
- Two-space indent, semicolons, double quotes
- LowerCamelCase for variables/functions, PascalCase for types
- Zod schemas with `.strict()` and `z.infer<>`
- Error handling via try/catch and throw
- JSX uses `/** @jsxImportSource hono/jsx */`
- File/dir names lowercase, hyphen-separated

## Cursor & Copilot

- No Cursor rules
- No Copilot instructions
