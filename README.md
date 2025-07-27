Expermental project of end-to-end type-safety starting from data ingestion.
The core schema should be validated the same way to the frontend.

The end goal is a fullstack web application in Typescript with global scalability for cheap.

For particality, I forked a the sst/models.dev project and configured it to pull from my RSS feeds to be indexed on a domain I already owned.

---

## API

You can access this data through an API.

```bash
curl https://natepapes/api.json
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
    articles: z.record(Article).optional(),
  })
  .strict();
```

**Model Schema:**

```ts
export const Article = z
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

- `providers/atomicobject/` - AtomicObject Articles
- `providers/github/` - Github Gists Article

### Working on frontend

Make sure you have [Bun](https://bun.sh/) installed.

```bash
$ bun install
$ cd packages/web
$ bun run dev
```

And it'll open the frontend at http://localhost:3000

---

spin.dev is created by the maintainers of [SST](https://sst.dev).

**Join our community** [Discord](https://sst.dev/discord) | [YouTube](https://www.youtube.com/c/sst-dev) | [X.com](https://x.com/SST_dev)
