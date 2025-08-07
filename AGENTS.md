# AGENTS Configuration

## Commands

- Install dependencies: `bun install`
- Dev server: `bun run dev`
- Build: `bun run build`
- Validate schema: `bun run validate`
- RSS feed update: `bun run rss`
- Test feeder: `bun run test`
- License checker: `bun run license-check`

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
