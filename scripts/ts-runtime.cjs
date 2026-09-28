// Preload for running app modules under plain ts-node (the seed and
// scripts/verify-metrics.ts): `ts-node -r ./scripts/ts-runtime.cjs <file>`.
//
// Next resolves three things that plain Node does not, and this supplies each
// with no dependency:
//   1. The `@/` path alias from tsconfig.json — mapped to the project root.
//   2. `server-only`, whose default export THROWS outside a React Server
//      Component environment. Its package publishes an empty build for the
//      `react-server` condition; scripts are server code, so they get that one.
//   3. `.env` — loaded with Node's built-in `process.loadEnvFile`, which does not
//      override variables already set (the Prisma CLI sets them for the seed).
//
// Scripts only. Nothing in the Next app loads this file.
//
// CommonJS on purpose: `ts-node -r` preloads it with `require`, before any
// TypeScript is compiled, so it cannot be an ES module.
/* eslint-disable @typescript-eslint/no-require-imports */
const Module = require("node:module");
const path = require("node:path");
const fs = require("node:fs");

const root = path.resolve(__dirname, "..");
const serverOnlyStub = path.join(root, "node_modules", "server-only", "empty.js");

const envFile = path.join(root, ".env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function resolveWithAliases(request, parent, isMain, options) {
  if (request === "server-only") return serverOnlyStub;
  const target = request.startsWith("@/") ? path.join(root, request.slice(2)) : request;
  return resolveFilename.call(this, target, parent, isMain, options);
};
