# PocoLobby upgrades without restarting agents

Investigation date: 2026-10-15, on repository snapshot `aa6a195` (package 0.1.3) and Claude Code 2.1.300 on macOS. Implemented in package 0.2.0. Package 0.3.0 adds what real Claude showed was missing: a [tool guide and catalog-change notices](#observed-claude-code-keeps-a-deferred-tools-first-schema), because Claude Code keeps a deferred tool's first schema for the whole session.

## Status

| Proposal section                                   | Status                                                                                                                                                                                                                                                        |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Bridge-only reconnect with `/mcp reconnect`     | **Passed with real Claude on macOS.** It is the normal local upgrade procedure; a full restart with the exact resume ID is the fallback. Windows: see below                                                                                                   |
| 2. No unnecessary configuration regeneration       | Implemented: the MCP file is reused when paths are unchanged; `mcp-config` names the install it wrote and `check-config` finds a stale one                                                                                                                    |
| 3. Feature tools from the broker                   | Implemented in 0.2.0: an authenticated, versioned catalog, a bounded dispatch endpoint, and a bridge that refreshes its tool list                                                                                                                             |
| 4. No remaining feature dependencies in the bridge | Implemented: a strict event envelope with bounded extension data and broker-composed presentation; generic initialization instructions                                                                                                                        |
| 5. Compatibility and the working Channel protocol  | Implemented in 0.2.0, since removed: the broker refuses a bridge older than its event version (`426 bridge_outdated`), and the bridge takes its feature tools only from the catalog. MCP SDK and protocol unchanged                                           |
| 6. Proof that later releases need no local update  | Passed under a simulated MCP host and in the installed-package smoke test. With real Claude, new operations reached the session but changed arguments of existing named tools did not; see [below](#observed-claude-code-keeps-a-deferred-tools-first-schema) |
| 7. Current arguments despite stale host schemas    | Implemented in 0.3.0: `tool_guide` in `get_context`, bootstrap and instruction text, `call_operation` for missing arguments, and one note per new catalog revision, appended to the next push from 0.8.2. Simulated host only                                 |

What an agent must do for a release is now one of:

| Change                                                               | Agent action                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Broker fix or redeploy                                               | None. The bridge reconnects by itself                                                                                                                                                                                                                                       |
| New broker feature within the current event version (tools, wording) | None. The bridge refreshes its tools and tells the host. The model is also told once of new operations and arguments, on its next push (a separate Channel notice before 0.8.2), and reads the new arguments in `list_operations`, `tool_guide` or through `call_operation` |
| Bridge fix, new local capability or a new event version              | Install the package at its usual path and run `/mcp reconnect pocolobby` in the conversation. After a new event version the broker refuses the older bridge until then                                                                                                      |
| Incompatible host or transport change, or a moved install            | Explicit migration in the release notes; a moved install also needs `mcp-config` again                                                                                                                                                                                      |

See [Operations](OPERATIONS.md#upgrade-procedure) for the procedure and [API](API.md#tool-catalog-and-dispatch) for the contract.

## What was implemented

### Bridge-only reconnect (section 1)

Evidence, real Claude, macOS (Mac Studio, agent `lando`, interactive Claude Code with `--remote-control`): the user installed 0.1.3 at the unchanged path and typed `/mcp reconnect pocolobby`. Claude answered "Reconnected". A fresh bootstrap arrived with a new nonce and `ready` succeeded. `runtime_id` was unchanged, the generation went from 2 to 3, `runtime_scope` was `conversation`, and no second Hello was sent. The conversation and other tools were untouched, and the new 0.1.3 tools appeared without a restart, so Claude refreshes tools on an MCP reconnect.

Windows (Servern, agent `vader`, Claude Code 2.1.299): the reconnect itself worked (same runtime, generation +1, fresh bootstrap, crons intact), but the new tools did not appear. That was not a Claude limitation. The MCP file pointed at an old npm prefix (`%APPDATA%\npm`, holding 0.1.1). After Node 26 was installed under the user profile, `npm root -g` moved, so the 0.1.2 and 0.1.3 installs went elsewhere and the reconnect kept starting 0.1.1. There is no observed case of Claude failing to refresh its tool list. A repeat of the Windows reconnect against the correct install is still to be recorded.

Two safeguards follow: `pocolobby mcp-config` prints the Node command, the module and that module's PocoLobby version it wrote, and `pocolobby check-config --mcp-config FILE` reports whether a generated file's command and module exist, which release the module is, and whether it matches the `pocolobby` on PATH. Neither reads the credential.

### Configuration reuse (section 2)

The generated MCP file contains absolute Node and module paths and the credential path, not a version. It stays valid across releases installed at the same location. Install and `mcp-config` must run under the same Node and npm prefix; see [Local setup](LOCAL-SETUP.md#host-setup-is-separate-from-the-markdown-file).

### Broker tool catalog and dispatch (section 3)

- `GET /v1/tools` returns `catalog_version`, a `revision`, the tools (name, description, JSON Schema) the caller may use, and the ones withheld for lack of a permission, with the reason. The revision is a hash of all of it, so a changed description, schema or permission is a new revision. It needs only the credential, never a runtime or bootstrap.
- `POST /v1/tools/:name` runs a registered tool. Each tool maps onto existing agent routes, and the dispatcher executes the same route handler as the HTTP request with the caller's credential and runtime headers. Validation, authorization, runtime fencing and idempotency are therefore shared. Only an allowlist of agent routes on the same broker is reachable: no owner routes, runtime claims, readiness, acknowledgments, checkpoints, other origins, query-string lobby selection, shell, or downloaded code.
- The bridge declares `tools.listChanged`. It loads the catalog at start, on every broker reconnect, and when a `catalog` event announces a different revision (sent on connect, after an owner permission change, and when the broker's tools change). It sends `notifications/tools/list_changed` only after a validated change, keeps the last good catalog through failures with bounded, jittered backoff (1 second doubling to 1 minute), and reports a failing refresh, a withheld tool and a removed tool with different messages.
- `get_context`, `ready`, `acknowledge_messages` and `save_checkpoint` stay in the bridge, tied to runtime fencing, receipts and acknowledgment filtering. A catalog entry with one of their names is ignored.
- `list_operations` and `call_operation` are two further fixed bridge tools whose definitions never change. A host that does not refresh its tool list can still discover and run every broker operation through them, with the same endpoint and validation. This is insurance: no such host has been observed.
- The bridge carries no copy of the broker's tools. Until the first catalog loads, the first `tools/list` waits up to 3 seconds for it and then lists only the bridge's own tools; a broker tool called meanwhile is refused with nothing sent. When the catalog arrives, the host gets one `tools/list_changed`.

### Envelope and presentation (section 4)

The event envelope keeps identity, delivery and receipt fields strict. The broker adds a bounded `presentation` to each message, covered header and receipts event: a lead line, a list summary, guidance sentences and optional extra attributes, composed from attributed fields, never from message text. The bridge renders it generically; message text stays in the JSON payload, so it cannot forge the first line. Other fields travel in a bounded `extensions` object (at most 32 keys and 4 KiB per object), which the bridge passes to the model unchanged. Identity, scope, priority, kind and reply attributes are still computed by the bridge and cannot be overridden. The bridge drops frames over 192 KiB; an event whose presentations would take it past 128 KiB is sent without them, and the bridge renders the same locally.

Initialization instructions are now generic: trust model, bootstrap, acknowledgments, checkpoints, retry IDs, and that tools can change while the session runs. Feature guidance lives in tool descriptions, results (such as `get_context` guidance) and push guidance, which the broker can update.

### Compatibility (section 5)

The 0.2.0 broker served older adapters exactly the event shapes they accepted, and the 0.2.0 adapter fell back to built-in tools against an older broker. Both were removed once compatibility with older releases was no longer needed: the broker accepts only its own event version and refuses an older bridge, or one that names none, with `426 bridge_outdated`, and the bridge takes its feature tools only from the catalog. The broker and the bridge of one release go together; deploy the broker first, then the package. The MCP SDK stays at 1.32.1 and the negotiated protocol at 2025-11-25: a Channel negotiating MCP 2026-07-28 cannot deliver messages.

## Observed: Claude Code keeps a deferred tool's first schema

**Evidence, real Claude.** Lando (macOS) and Vader (Windows, Claude Code 2.1.299) ran the 0.2.0 bridge in sessions that load MCP tools on demand through tool search (deferred tools). After a broker-only catalog change, `list_operations` showed the new definitions. But Claude's own copy of the existing named tool `send_message` kept the schema the session had loaded first: the 0.1.1 schema, with no `kind`, `reply_expected`, `deliver_at` or structured fields. It stayed that way through two `/mcp reconnect pocolobby` upgrades, to 0.1.3 and then 0.2.0. Newly named tools did appear after a reconnect. Calls with fields unknown to Claude's copy still worked: the model can pass them, the bridge does not check them against the host's copy, and the broker validates them. The bridge does send `notifications/tools/list_changed` after a validated change once the host has listed tools, so Claude Code apparently does not refresh existing deferred tool schemas, on reconnect or on `list_changed`. A source review by the Codex development partner agreed: existing deferred definitions survive reconnect and resume, new names appear, and calls with the new argument shape reach the server. Upstream report: anthropics/claude-code#97369. This is observed host behavior, not root-caused.

**Consequence.** Section 6's promise holds for new operations and for the broker's behavior, but not for new arguments or wording on an existing named tool: a running session may never see them in its tool list. Never rely on a named tool's schema or description reaching a running session.

**What PocoLobby does instead** (from 0.3.0).

- `get_context` returns a compact `tool_guide`: every catalog operation with a one-line purpose and its current argument names with short meanings, and the catalog revision. The broker generates it from the same permission-filtered catalog and revision that `GET /v1/tools` serves, so there is no second manual to keep in step. Full types, enums and limits stay in `list_operations`.
- The bootstrap event and the MCP instructions say that the tool list may show older schemas, that the named tools accept every argument in `tool_guide`, including attachments, and that `call_operation` is the supported way to pass arguments absent from the cached schema. After an uncertain send, keep the original arguments and `client_request_id` when switching between the named tool and `call_operation`.
- A broker-only release starts no bootstrap, so the bridge tells the model once per new catalog revision that adds or removes an operation or adds an argument ("PocoLobby tool catalog changed (revision …). New operations: … New arguments: …"), pointing at `list_operations` and `call_operation`. Up to 0.8.1 that was a separate Channel notice; from 0.8.2 it is appended to the next push the bridge delivers, with `catalog_revision` in the push's meta, so it no longer wakes an idle session on its own, and a `get_context` showing the current revision clears it. It keeps `tools/list_changed`. No polling and no readiness handshake: none before bootstrap completes, at most one per revision, none for a change of wording only, none on a reconnect with an unchanged revision.
- New capabilities take new names where that is natural, because new names do appear after a reconnect: `get_attachment` is a new bridge tool. `attachments` on `send_message` also works when Claude's copy of the schema lacks it, since the bridge decides from its current catalog; a test sends attachments through a named tool whose host-cached schema lacks them, and through `call_operation`. Versioned aliases such as `send_message_v2` are deferred.

**The supported way to keep agents current without a session restart** is therefore: the broker catalog plus `tool_guide` in `get_context` for what exists now, `call_operation` for anything the named schemas lack, and the catalog-change note on the next push to say when to look. A bridge reload with `/mcp reconnect pocolobby` is still needed for bridge changes, and it adds new tool names, but it does not refresh the schemas Claude already holds.

## Validation

Everything below used a **simulated MCP host**. Real Claude has since run 0.2.0, with the result above; no real Claude session has run 0.3.0.

- Acceptance test (`test/upgrade.test.ts`): a real `pocolobby adapter` subprocess under a simulated host. With the bridge process and its files unchanged, only the broker gains a tool and an optional argument on an existing tool. The host receives `tools/list_changed`, lists and calls both, and messaging and Channel delivery continue. The same test covers a host that ignores the notice and uses `list_operations`/`call_operation`, a broker restart with an unchanged catalog (no notice, no new bootstrap, same runtime), a deploy that removes tools (reported as removed), an owner permission change in both directions (reported as a permission), and retry identity throughout.
- A bridge started while the broker is down lists only its own tools and refuses broker tools, then adopts the catalog when the broker appears. An uncertain send whose answer is lost across a broker restart is never resent by the bridge; retrying with its `client_request_id` returns the stored message.
- Bridge unit tests with a fake broker: malformed, oversized and newer-format catalogs, refresh backoff and recovery, catalog-only tools before the first load, removal versus permission versus refresh failure, and envelope presentation and extension bounds.
- Broker tests: catalog filtering and revisions, dispatch sharing validation, idempotency, fencing and lobby boundaries with the HTTP routes, the route allowlist, catalog announcements, and the refusal (`426`) of a bridge that declares an older event version, or none, while a higher one is answered with version 5.
- The installed-package smoke test replaces the packaged broker with one that adds a tool and an optional argument, while the installed bridge keeps its PID and its files their digest; the host receives the change, calls both, and messaging continues.
- Dropping compatibility with older bridges (one event version, tools only from the catalog) was validated with the automated suite under a simulated host only.
- 0.3.0 (`test/attachments-adapter.test.ts`): a host that listed `send_message` from a catalog without `attachments` keeps that schema while the broker gains `attachments`; the named tool and `call_operation` both carry attachments, and a repeated request ID on the other path deduplicates. A catalog change produces exactly one Channel notice; the same catalog again, a broker restart with it, and a return to a revision the model already read produce none; a third revision produces one more. `get_context` carries `tool_guide`, and the bootstrap text points at it.

## Still to validate with real Claude

- That a real session reads `tool_guide` and uses a new argument through the named tool or `call_operation` after a broker-only change, and how it treats the catalog-change notice.
- The decisive test with a real conversation: a broker-only feature release reaching a running session through `tools/list_changed`, then bootstrap, unsolicited push, acknowledgment and reply. Real Claude has so far shown new tool names arriving after a reconnect, and existing schemas not refreshing.
- A bridge reload by `/mcp reconnect pocolobby` on Windows against the correct npm prefix.
- That a bridge refused with `426 bridge_outdated` comes back after the package install and `/mcp reconnect pocolobby`.
- That Claude re-reads tool descriptions changed in place, and how it treats a tool that disappears mid-session. The removal of `set_status` (0.7.0) is the first such case in running sessions.

## Original findings

### Broker updates already tolerated older agents

The 0.1.3 broker supported 0.1.1 and 0.1.2 adapters through event-version negotiation and compatibility shaping. Existing adapters reconnected and continued messaging; they needed an adapter upgrade only to expose new tools and options. Current brokers no longer do this: they refuse a bridge older than their event version.

### The local bridge contained feature-specific code

Up to 0.1.3 the adapter hardcoded tool definitions, argument schemas, API routing, feature instructions, notification schemas and wording, and declared `tools: {}`. Updating only the tool list would have left the other dependencies, and strict notification schemas made every new message field a local change.

### Claude supports reconnecting one MCP server

`/mcp reconnect pocolobby` is typed in the conversation, not in a shell. Read-only inspection of Claude Code 2.1.300 found reconnect handling that re-establishes MCP connections, refreshes tools and re-registers Channel notification handlers; its stdio launch supplies `CLAUDE_CODE_SESSION_ID` to the adapter, so the runtime survives. Sources: [Claude MCP management](https://code.claude.com/docs/en/mcp#managing-your-servers) and [Remote Control limitations](https://code.claude.com/docs/en/remote-control#limitations).

### Dynamic tool updates are part of MCP

MCP supports `tools.listChanged` and `notifications/tools/list_changed`, and Claude documents refreshing tool definitions when it receives them. Sources: [Claude dynamic tool updates](https://code.claude.com/docs/en/mcp#dynamic-tool-updates) and [MCP tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).

### Experiments before implementation

All under a simulated MCP host: restarting a real broker kept the adapter subprocess, runtime and readiness; replacing only the adapter subprocess with the same conversation ID kept the runtime, raised the generation and deduplicated the greeting; and changing an MCP tool catalog over an existing SDK connection let a host discover and call a new tool without reconnecting.

### Proposal constraints that still hold

Perform a reload between PocoLobby tool calls. Retain request IDs for uncertain sends and reconcile their results. Never reset runtime ownership automatically to make a reconnect succeed. A self-updating daemon or supervisor was judged unnecessary. A package version bump alone must not imply restarting every agent; release notes say whether a release needs no agent action, a bridge reload, or a migration.
