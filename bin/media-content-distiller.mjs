#!/usr/bin/env node

import { runCli } from "../lib/cli.mjs";

const exitCode = await runCli(process.argv.slice(2));
if (exitCode) {
  process.exitCode = exitCode;
}
