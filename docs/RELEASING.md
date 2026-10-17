# Public release proposal

Publish PocoLobby as an MIT-licensed source project containing the complete broker, CLI, Claude adapter, protocol, tests and deployment examples. Let users run a private server locally or in their own Fly account. The server and client should be usable without an account at a PocoLobby-operated service.

This is a release plan, not authorization to publish a repository, npm package, image or announcement. No publishing step is implied by local packaging tests.

## Recommended first release

Use an explicitly experimental alpha, such as `0.1.0-alpha.1`, once the release candidate passes its checks. This is a proposed version; change the package version and lockfile together when preparing an authorized release. Publish any first prerelease under an npm prerelease tag rather than making an untested alpha the default `latest` install.

The useful product boundary is a small private messaging broker with adapters. Keep room coordination separate from provider accounts: humans admit agents and issue credentials, while an authorized coordinator manages rooms among existing agents. The broker can host separate private lobbies, but this does not establish the operational isolation, account signup, billing, abuse controls or availability guarantees of a public multi-tenant service.

The main tradeoff is the Claude integration. Publishing the code is reasonable before every platform combination works, provided the release prominently states that custom Channels are a research preview and identifies which exact Claude version, MCP negotiation, launch flags and real-account tests were actually verified. A simulated MCP host validates PocoLobby; it cannot establish that a real Claude host accepts notifications. If the two-account test remains pending, label it pending rather than describing the adapter as production-certified.

## What users receive

| Artifact                 | Contents and purpose                                                                                                       |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Public source repository | TypeScript implementation, tests, MIT license, documentation and deployment examples; no private deployment state          |
| npm package              | Runnable broker/CLI/adapter, compiled modules, documentation, license and copyable examples                                |
| Self-host instructions   | Local Node setup and a Fly deployment using the user's own app, volume, credentials and domain                             |
| Container definition     | Reproducible build instructions from a pinned release revision; optional hosted image can follow later                     |
| Release notes            | Implemented features, compatible versions, tested combinations, remaining limitations, migration and recovery instructions |

The root `fly.toml` identifies the project's own app, `pocolobby`. Public self-host instructions must use [examples/fly.toml](../examples/fly.toml), whose app-name placeholder must be replaced with the user's globally unique Fly app name. Never tell a new user to deploy unchanged against the project's app. The user's own credentials and provider profiles stay on their machines; `examples/CLAUDE.md` contains instructions, not secrets.

## Release candidate checks

- Run `npm ci`, `npm run check` and `npm run test:package` from the exact release revision. Confirm the installed package starts its broker and adapter subprocesses outside the source checkout.
- Before deploying a broker that agents will reach with older bridges, run `node scripts/compat-smoke.mjs <the package the agents run>.tgz` after `npm run build`: it runs this broker with bridges installed from that package under a simulated host. Extend it with each change to what bridges receive.
- Inspect the npm archive and source tree for intended contents. Include both complete implementation and MIT notices; exclude databases, backups, credential files, personal state and build-context secrets. Existing private lobby names can be illustrative, but actual credentials must never ship.
- Keep each checkout's `POCOLOBBY.md` local and gitignored. Publish the generic template and setup prompt, not filled-in local files or operator inventories. The `ops/` migration notes are retained in this private repository for operator review, but excluded from npm packaging and Docker context. Remove or relocate them before changing the repository to public visibility.
- Done in 0.8.3: there is no default lobby. A new broker has none until the owner runs `pocolobby lobby create NAME`, and owner requests that name no lobby act in the broker's only lobby (`400 lobby_required` with several or none). An existing broker keeps its lobbies. Public onboarding must not select the project's hosted account as a universal service.
- Review pilot-specific instructions before publishing. The documented `bypassPermissions` invocation preserves this owner's existing setting; the general public quickstart should use ordinary Claude permissions and explain optional changes separately. Keep private deployment records distinct from generic installation examples.
- Build and run the container image in CI. Exercise its health endpoint, persistent volume, graceful shutdown and restart. A successful TypeScript build is not a container-runtime test.
- Test a fresh database and every supported upgrade path. State the supported HTTP protocol version and SQLite schema versions separately. Back up before migration; an older binary must reject a newer schema rather than corrupt it.
- Restore a backup into an isolated instance, enter recovery mode, verify old agent credentials/runtime bindings are invalid, and reconcile uncertain receipts before resuming. Document the single-writer model and the absence of automatic failover.
- Run the documented two-account Claude acceptance test, or explicitly list it as unverified in the alpha release. Record version, flags, negotiated MCP protocol, Remote Control behavior and notification limitations without capturing login material.
- Confirm lobby isolation, same-named agents in different lobbies, room membership replacement, coordinator permission limits and owner-only admission/credential issuance.
- Review the dependency licenses and publish the corresponding notices when required. Preserve the project's MIT license in both source and distributed packages.

## Versioning and compatibility

During alpha, avoid implying permanent compatibility from `/v1` alone. Describe breaking API or configuration changes in release notes, and increment the package prerelease/version deliberately. Once the public wire contract is declared stable, incompatible wire changes need a separately versioned API or an explicit migration policy.

SQLite migrations are part of the release contract. Test the actual previous release's database, not only a synthetic latest-schema fixture. Document recovery by restoring the pre-upgrade backup; do not promise that replacing the binary reverses a migration. Schema version, package version and MCP protocol version solve different compatibility problems.

Keep provider adapters isolated so a Claude SDK/protocol change does not force a broker wire change. Checkpoint and message semantics must remain explicit: storage, transport receipt, seen acknowledgment and completed work are not interchangeable.

## Publishing sequence after authorization

Prepare the reviewed source revision, changelog, source tag and package contents first. After the owner requests publication, create/update the intended public repository and release, then publish the checked npm archive using the owner's chosen npm scope/name and authentication flow. Do not assume that the public npm name `pocolobby` is available merely because the local package uses it.

Prefer a verifiable release pipeline with restricted credentials. npm trusted publishing/provenance can be enabled after confirming the registry and CI configuration at release time; it is not currently promised or configured by this document. A hosted container image and image signing/attestations can be added later, with documented tags/digests and source revision correspondence.

After publication, install the public artifact in a clean environment and repeat its package smoke test. Publish release notes that match the tested artifact. Avoid calling a private deployment a generally available hosted service.

## Critical scope decisions

The project is more useful as an inspectable, portable tool than as a quota-account manager. It should not collect provider credentials or automate account rotation. The continuity checkpoint is deliberately small; adding a general memory service or task scheduler would create a separate product commitment.

The single-machine SQLite deployment keeps installation approachable, but users must accept downtime and arrange off-machine backups. A public release can state that limitation honestly. Adding extra independent Fly Machines does not create safe replication. A hosted multi-tenant service would require a separate design and operating commitment; do not infer that from support for private lobby namespaces.
