#!/usr/bin/env node
import { register } from "node:module";
import { pathToFileURL } from "node:url";

// Register tsx as a TypeScript ESM loader so Node.js can execute .ts files directly.
// Requires Node.js >= 20.6 (22+ recommended). tsx must be a runtime dependency.
register("tsx/esm", pathToFileURL("./"));

await import("../src/index.ts");
