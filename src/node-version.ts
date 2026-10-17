// Loaded by bin.ts before anything else, so it must not import anything and must parse
// on the old Node versions it reports. Keep package.json engines in step.
export const MINIMUM_NODE_MAJOR = 24;

export function unsupportedNodeMessage(version: string, execPath: string): string | undefined {
  if (Number(version.split('.')[0]) >= MINIMUM_NODE_MAJOR) return undefined;
  return `PocoLobby needs Node.js ${MINIMUM_NODE_MAJOR} or newer; this is v${version} at ${execPath}. Install Node.js ${MINIMUM_NODE_MAJOR} or newer and put it first on PATH.`;
}
