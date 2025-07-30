#!/usr/bin/env bun

import { execSync } from "child_process";
import fs from "fs";

const licenses = execSync("bunx license-checker");
fs.writeFileSync("licenses.txt", licenses.toString());
