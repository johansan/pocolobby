#!/usr/bin/env node
// The installed `pocolobby` command. Static imports load before any module code runs, so
// check the Node version first and load the CLI, which needs newer Node, only afterwards.
import { unsupportedNodeMessage } from './node-version.js';

const problem = unsupportedNodeMessage(process.versions.node, process.execPath);
if (problem) {
  process.stderr.write(`pocolobby: ${problem}\n`);
  process.exitCode = 1;
} else {
  import('./cli.js')
    .then(({ main }) => main())
    .catch((error: unknown) => {
      // A broken install: say what failed instead of an unhandled rejection.
      process.stderr.write(
        `pocolobby: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}
