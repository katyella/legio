#!/usr/bin/env node
import { register } from "node:module";

// Register tsx as a TypeScript ESM loader so Node.js can execute .ts files directly.
// Requires Node.js >= 20.6 (22+ recommended). tsx must be a runtime dependency.
// Use import.meta.url (not pathToFileURL("./")) so resolution is relative to this
// shim file, not the process CWD — which is critical when legio is installed globally.
register("tsx/esm", import.meta.url);

await import("../src/index.ts");
