[![license-check](https://github.com/papes1ns/spin.dev/actions/workflows/license-check.yml/badge.svg)](https://github.com/papes1ns/spin.dev/actions/workflows/license-check.yml)
[![validate](https://github.com/papes1ns/spin.dev/actions/workflows/validate.yml/badge.svg)](https://github.com/papes1ns/spin.dev/actions/workflows/validate.yml)
[![deploy](https://github.com/papes1ns/spin.dev/actions/workflows/deploy.yml/badge.svg)](https://github.com/papes1ns/spin.dev/actions/workflows/deploy.yml)

<p align="center">
  <img src="https://natepapes.com/favicon.svg" alt="favicon" width="64" height="64"/>
</p>

An experimental fullstack project exploring end-to-end type safety from data ingestion to the frontend using a shared schema validated across the stack.

This project builds on a fork of the excellent <a href="https://github.com/sst/models.dev">sst/models.dev</a> repo.

> For practicality, it’s currently configured to pull content from my personal RSS feeds and index them on a domain I already own.

## TODO

- [x] add licsense checker to audit the open source supply chain
- [x] add robots.txt to disallow all scraping
- [ ] add pivacy page, no PII is collected, CF analytics tracks device data to protect the service
- [ ] add terms page, conform to GDRP in combo with the privact page
- [ ] setup a `vitest` test suite ideally in its own module eg., `@spin.dev/test`
- [ ] write unit test that the rss.ts script fails if the USER_AGENT is in a providers robots.txt
- [ ] wrtie unit test that the rss.ts script fails if the HTTP status codes suggest not to scrape
- [ ] setup preview environments for PRs
- [ ] setup and end-to-end test script to test the robots.txt blocks scraping
- [ ] make the main contents table mobile responsive

## API

You can access this data through an API.

```bash
curl https://natepapes.com/api.json
```

### Validation

There's a GitHub Action that will automatically validate your submission against our schema to ensure:

- All required fields are present
- Data types are correct
- Values are within acceptable ranges
- TOML syntax is valid

### Schema Reference

Models must conform to the following schema, as defined in `packages/core/src/schemas.ts`.

**Provider Schema:**

```ts
export const Provider = z
  .object({
    id: z.string().toLowerCase(),
    name: z.string(),
    profile: z.string().url("Must be a valid URL"),
    rss: z.string().url("Must be a valid URL"),
    contents: z.record(Content).optional(),
  })
  .strict();
```

**Content Schema:**

```ts
export const Content = z
  .object({
    id: z.string().toLowerCase(),
    title: z.string(),
    description: z.string().optional(),
    url: z.string().url("Must be a valid URL"),
    /** ISO-8601 timestamp of publish date */
    created_at: z.string(),
    /** Estimated reading time in minutes */
    reading_time_minutes: z.number().int().positive().optional(),
    tags: z.array(z.string()).optional(),
  })
  .strict();
```

### Examples

See existing providers in the `providers/` directory for reference:

- `providers/atomicobject/` - spin posts
- `providers/github/` - gist posts
- `providers/youtube/` - youtube posts

### Working on frontend

Make sure you have [Bun](https://bun.sh/) installed.

```bash
$ bun install
$ cd packages/web
$ bun run dev
```

And it'll open the frontend at http://localhost:3000

---

spin.dev is a fork maintained by me inspired by the creators and maintainers of [SST](https://sst.dev). Please support and credit them for the awesome work they are doing.
