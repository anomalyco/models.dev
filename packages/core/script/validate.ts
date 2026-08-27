#!/usr/bin/env bun

import { generate } from "../src/generate";
import path from "path";
import { ZodError } from "zod";

try {
  const result = await generate(
    path.join(import.meta.dirname, "..", "..", "..", "providers"),
  );
  console.log(JSON.stringify(result, null, 2));
} catch (e: any) {
  if (e instanceof ZodError) {
    console.error("Validation error:", e.errors);
    console.error("When parsing:", e.cause);
    process.exit(1);
  }
  throw e;
}
