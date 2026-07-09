// Drift protection between @models.dev/core's Zod schemas (the source of
// truth) and this package's hand-written interfaces. The type-level
// assertions fail `tsc --noEmit` (part of the test script) whenever the
// schemas and the published types stop being exactly mutually assignable.

import type { z } from "zod"
import * as Core from "@models.dev/core"
import type { Catalog, Model, ModelFamily, ModelMetadata, Provider } from "../src/index.js"

type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false
type Expect<T extends true> = T

// If one of these lines errors, a schema in packages/core changed shape:
// update src/types.ts (or src/generated.ts via `bun run generate`) to match.
type _provider = Expect<Equal<z.infer<typeof Core.Provider>, Provider>>
type _model = Expect<Equal<z.infer<typeof Core.Model>, Model>>
type _metadata = Expect<Equal<z.infer<typeof Core.ModelMetadata>, ModelMetadata>>
type _family = Expect<Equal<Core.ModelFamily, ModelFamily>>
type _catalog = Expect<Equal<Awaited<ReturnType<typeof Core.generateCatalog>>, Catalog>>
