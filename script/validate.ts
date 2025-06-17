#!/usr/bin/env bun

import { generate } from "@models.dev/core";
import path from "path";

const result = await generate(path.join(import.meta.dir, "..", "providers"));

console.log(JSON.stringify(result, null, 2));
