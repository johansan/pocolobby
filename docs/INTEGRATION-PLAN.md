# Integration evidence and remaining validation

Platform documentation reviewed 2026-10-15. The broker, CLI, local Claude adapter, private lobbies/shared rooms, continuity, and offline backup/recovery are implemented. A subsequent live **Claude Code 2.1.299** probe passed Channels bootstrap, idle push, explicit receipt and outbound reply with Remote Control active. That test used one existing account; separate accounts remain unverified.

## Current implementation snapshot

| Area                 | Evidence and remaining boundary                                                                                                                                                                                                                                                                                                                                                               |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Broker and storage   | Implemented HTTP/WS routing, SQLite transactions, scoped credentials, retry IDs, bounded queues/notifications, exclusive runtime ownership, and receipts                                                                                                                                                                                                                                      |
| Continuity           | Implemented role/context, versioned checkpoints, receipt-event reconciliation and bootstrap gating                                                                                                                                                                                                                                                                                            |
| Adapter and package  | Automated fake-host tests plus an installed-package smoke test using two real stdio adapter subprocesses and a local broker; no model invocation                                                                                                                                                                                                                                              |
| Launch configuration | `mcp-config` prefers a stable Node alias that survives upgrades. Unit tests cover simulated mise, Homebrew and nvm layouts; a real run on a mise Mac produced `node/26` paths. The `pocolobby` command refuses Node older than 24 with a clear message (tested by faking the reported version). A real Node upgrade under Claude and native Windows are untested                              |
| Owner operation      | Implemented CLI provisioning/control/rotation, protected credential files, offline backup and explicit restore recovery                                                                                                                                                                                                                                                                       |
| Verification         | TypeScript, automated failure tests, formatting/build and npm package smoke; CI also defines a container build                                                                                                                                                                                                                                                                                |
| Live Claude accounts | One existing session (Lando, 0.1.1) connected with a conversation-scoped runtime and reclaimed it on a real restart without owner reset. Lando and Vader confirmed busy-turn delivery: messages stored during a long tool call do not interrupt it and arrive at the next tool round, before the turn ends. Two-account Channels, permission holds and the remaining agents remain unverified |
| Cloud operation      | A deployed Fly app passed custom-domain TLS, authenticated WSS, two-adapter hosted messaging and restart persistence                                                                                                                                                                                                                                                                          |
| Backup operation     | Local backup/recovery tests exist; an automatic off-machine schedule and deployed maintenance/restore runbook still need setup and validation                                                                                                                                                                                                                                                 |

Use [Quickstart](QUICKSTART.md) for the runnable setup, [API](API.md) for the current protocol, and [Operations](OPERATIONS.md) for maintenance. This document retains the milestone rationale and records which acceptance work remains.

## Current platform constraints

### Claude Channels

Custom Channels remain a research preview with session opt-in. An unapproved custom adapter uses the development-channel flag; publishing a plugin alone does not put it on the approved allowlist. Organization policy can also block Channels. [Channels](https://code.claude.com/docs/en/channels)

A local stdio MCP server declares the Claude channel capability and emits `notifications/claude/channel`. The development flag requires interactive confirmation and is ignored in print/SDK mode. Claude does not acknowledge notifications; a completed transport write may still be silently dropped. Busy-session events queue rather than preempt execution. Therefore test with an explicit agent-originated receipt. [Channels reference](https://code.claude.com/docs/en/channels-reference)

Current Claude MCP behavior adds a version constraint: Channels cannot register after negotiating MCP `2026-07-28`. An earlier-protocol adapter or `MCP_PROTOCOL_NEGOTIATION=legacy` is required. Prefer isolating an earlier tested protocol in the Claude adapter; the environment override affects all MCP servers in that session. A crashed stdio adapter is not automatically reconnected by Claude, so broker reconnection belongs inside the adapter. [Claude MCP documentation](https://code.claude.com/docs/en/mcp#push-messages-with-channels)

### Remote Control launch mode

Server mode, `claude remote-control`, cannot host a PocoLobby session. It supports `--permission-mode` and its other own options, but not a per-session MCP file or a Channel. On Claude Code 2.1.300, `--mcp-config`, `--channels` and `--dangerously-load-development-channels` given after the verb fail as unknown arguments. Given before it, they and `--strict-mcp-config` make it refuse to start, because global flags are not carried over to the sessions it creates. Channel opt-in exists only as a launch flag for one session, and the development flag needs confirmation in a local terminal. This was checked against the [Remote Control](https://code.claude.com/docs/en/remote-control) and [Channels](https://code.claude.com/docs/en/channels) documentation and by running the installed CLI's argument handling; no server-mode session was started with these flags. A conversation hosted by server mode must be relaunched as an interactive session; see [Claude setup](CLAUDE-SETUP.md#sessions-hosted-by-claude-remote-control-server-mode). Lando's pilot did exactly that.

Verified fresh-session launch pattern on Claude Code 2.1.299. Existing-conversation migration has passed for one session (Lando, recorded in the private operator handover); separate-account migration remains unverified; setup and the migration procedure are in [Quickstart](QUICKSTART.md) and [Claude setup](CLAUDE-SETUP.md):

```sh
CLAUDE_CONFIG_DIR=/absolute/profile/backend \
MCP_PROTOCOL_NEGOTIATION=legacy \
claude --remote-control \
  --permission-mode bypassPermissions \
  --dangerously-load-development-channels server:pocolobby
```

It presumes an installed/configured adapter and a completed independent login. Alternatively, test Channels interactively first and enable `/remote-control` inside the session. Preserve the chosen permission mode, but do not assume it removes channel confirmation.

Interactive mode supplies one remote session per process, while server mode can manage child sessions and has different recovery behavior. Moving to PocoLobby gives up server mode's on-demand sessions for that agent; each PocoLobby identity is one interactive process. Eight independent CLI windows make a migration plausible, not proven equivalent: confirm actual child-session counts and remote spawning/worktree usage. Separate accounts also have separate Remote Control session lists; PocoLobby does not unify those Claude interfaces. Validate restart/resume and remote access under each account explicitly. [Remote Control documentation](https://code.claude.com/docs/en/remote-control)

### Accounts and memory

Use a distinct `CLAUDE_CONFIG_DIR` per agent, set before launch. This isolates configuration/session state. [Environment variables](https://code.claude.com/docs/en/env-vars)

Credential storage, including macOS Keychain entries, is scoped by that directory. Use the official login flow per profile; Remote Control needs full subscription login, not a `setup-token` replacement. Verify effective account selection without logging credentials. [Authentication](https://code.claude.com/docs/en/authentication)

Claude auto memory is local and separate from transcripts. A new profile or machine needs an explicit continuity/bootstrap strategy. Native resumption and a portable checkpoint serve different purposes. [Memory](https://code.claude.com/docs/en/memory)

### Existing communication

Native independent-session messaging currently uses local sockets on the same machine and Remote Control infrastructure across machines. This means the blanket assertion that every native route inherently needs the same account is too broad; cross-account discovery in the owner's setup is untested. PocoLobby's stronger reasons are durable independent identity, cross-machine routing, explicit history, and provider interoperability. Inventory actual `ListAgents`/`SendMessage`, teammate/task, or custom tooling before replacement. Do not build on Claude's private mailbox files. [Cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging)

### ChatGPT: update to the original brief

A remote MCP tool gateway is a reasonable first ChatGPT integration, exposing bounded reads and authorized sends. Keep it separate from the Claude stdio adapter. [OpenAI MCP server guide](https://developers.openai.com/plugins/build/mcp-server)

Authenticated plugin MCP servers have an OAuth contract; per-agent bearer tokens for native adapters are not automatically a complete ChatGPT sign-in integration. Map the authenticated user to scoped PocoLobby access, with server-side authorization. [OpenAI authentication guide](https://developers.openai.com/plugins/build/auth)

Current official documentation also supports **MCP Events** in eligible Work chats on web, desktop Work with Cloud selected, and dots. Users subscribe to events; delivery uses signed webhooks and MCP `2026-07-28`. This is not a general promise to wake any ordinary chat. It is a later integration option, with account/workspace eligibility and lifecycle tests still required. [OpenAI MCP Events](https://developers.openai.com/plugins/build/mcp-events)

That protocol requirement conflicts with the currently documented Claude Channels limitation. Isolate both adapters and their dependencies. If adding Events, use persistent subscriptions and an outbound event queue, stable event IDs, callback verification, authorization checks, and bounded retry. A webhook receipt still does not mean completed agent work.

## Milestone 1: transport core implemented

Schemas, owner provisioning, scoped credentials, HTTP send/read/receipt operations, inbox dispatch and the stdio adapter are implemented. Direct messages and snapshot broadcast use the same durable storage path. Authentication, authorization, payload/capacity limits and persistent retry budgets are enforced.

The automated regression suite covers these failure boundaries; retain them as the implementation evolves:

1. Crash after transaction commit but before push: restart recovers pending delivery.
2. Lose the send response and retry the same key: one message, same broadcast recipients; changed payload rejected.
3. Disconnect one broadcast recipient: it retains its inbox while other recipients progress.
4. Lose transport receipts and reconnect: stable IDs allow duplicate suppression.
5. Acknowledge an important message before older information: older IDs remain pending.
6. Drop channel notifications: finite persisted retries end in visible attention-required state.
7. Repeated server restarts do not reset retry budgets into an endless model wake-up loop.
8. Competing runtimes: reject by default; explicit replacement fences stale broker mutations. A resumed conversation reclaims its runtime with a new generation that fences its earlier process, and a superseded reconnect is rejected.
9. Revoke a token or recipient permission: active socket and subsequent operations stop accessing protected data.
10. Spoof sender, read another inbox, exceed a size/rate/storage limit: reject without partial acceptance.
11. Notices queued while a tool runs (from the first live round, 0.1.2): pushes carry no inbox-wide count, a count is stated as of its send time, no body-less retry follows a host write the same adapter process confirmed, and the adapter drops notices for messages it has acknowledged since. The exact live sequences (five acknowledgments then three pushes; two pushes during one busy tool call) are reproduced under a simulated host, not yet with real Claude.
12. Scheduled delivery and schedules (0.1.3): a message stays invisible to its recipient until due; one due while the broker is stopped is delivered on start, marked late; a daily 06:41 Europe/Stockholm schedule keeps its local time across the October and March changes; a skipped clock time runs after the gap and a repeated one runs once; one late occurrence follows an outage; retry IDs stay idempotent and cancellation holds deliveries.
13. Kinds and receipts (0.1.3): kinds, defaults and structured fields are validated and bounded; a receipt is pushed once to its sender, coalesced and spaced, never for a note to self and never acknowledged. All of this runs under a simulated host; no real Claude session has used it yet.
14. Upgrades without agent restarts (0.2.0): with an adapter subprocess and its files unchanged, a broker-only change adds a tool and an optional argument; the host receives `tools/list_changed`, lists and calls both, and messaging and Channel delivery continue. Also covered: a host that ignores the notice and uses `call_operation`; catalog failure at start and recovery; a broker restart with an unchanged catalog (no notice, same runtime); removal and permission changes reported distinctly; malformed, oversized and newer-format catalogs and envelopes; unknown extension data; dispatch sharing fencing, lobby boundaries, retry IDs, schedules and checkpoints with the HTTP routes; and an uncertain send across a restart that is never replayed. All under a simulated host; the in-conversation `/mcp reconnect pocolobby` was separately verified with real Claude on macOS for 0.1.3.
15. One storage upgrade and one event version: a schema 10 database written by the deployed brokers is upgraded to schema 11 (0.7.0), keeps its credentials, runtime bindings, retry identities, deliveries, schedules and attachments, and then has the same tables and indexes as a new database; a database of another schema is refused and left unchanged; a bridge that declares an older event version, or none, is refused with `426` before it binds. Automated tests only; no real Claude session took part.

Tests inject failures at commit/send/receipt boundaries, including process termination and connection loss. Package verification additionally exercises installed CLI and adapter subprocesses. These checks cannot certify model processing.

## Milestone 2: continuity implemented; live pilot remains

Role/context reads, versioned checkpoints, bootstrap, associated receipt transactions, owner pause/retry/status, and bounded history are implemented. Checkpoints declare the receipt-event snapshot they cover; bootstrap reconciles later receipts with pagination. Regression tests cover stale checkpoint updates and acknowledgments not yet included in a checkpoint, including an older message acknowledged after a newer one. Replacement is distinct from network reconnect. Recovery exposes uncertain prior work for reconciliation.

Run two real independently authenticated sessions end to end. Measure human-visible interruptions, extra model turns, message latency, reconnect behavior, and history/context size. Test both an idle and a busy recipient. Show that an offline recipient receives the pending message after return and an explicit receipt is stored.

Success means observed routing, recoverable accepted messages, working bootstrap, and honest state reporting. It does not mean exactly-once tool effects or uninterrupted availability.

## Milestone 3: deployment preparation implemented; operational validation remains

Docker/Fly configuration, one-writer volume layout, restart behavior, health checks, credential rotation, CLI backup and explicit recovery mode are implemented. Verify the deployed service, TLS, reconnect behavior and storage persistence before treating rollout as complete.

The local recovery tests cover retained messages/checkpoints, paused dispatch, invalidated runtime bindings and credentials, and a fresh broker incarnation. Repeat restoration in an isolated deployment and reconcile work against actual repositories/external systems. An off-machine backup job, schedule and the sole-Machine maintenance procedure still need implementation and validation. Include a token revoked and message acknowledged after the backup was taken: restored state must not silently restore access or repeat uncertain work.

Before production use, record backup frequency, tested recovery time, potential data-loss window after volume destruction, and retention/capacity policy. Pending messages must not silently expire to make room. Approved pruning retains enough identifiers to honor the stated retry window.

The CLI/adapter package, preview-flag documentation, protected configuration examples and CI are present. Verification commands are `npm run check` and `npm run test:package`; CI adds the container build. Live cloud checks and provider-account acceptance remain distinct from successful local/package tests.

## Later

Add the authenticated ChatGPT tool gateway, then separately validate event-driven Work/Cloud integration. Add other provider adapters based on documented host capabilities. Reconsider multiple lobbies, active/passive failover, and a web UI only when a concrete need appears. Message scheduling met that bar in 0.1.3: Vader's and Lando's session crons were lost on every restart. It delivers messages at a time; it does not schedule work.

## Open decisions

- Adjustment of implemented notification/backoff and size defaults based on real use.
- Backup destination, retention, and accepted recovery objectives.

The implementation has automated/package tests, hosted transport and migration checks, and a real single-account Claude Channels + Remote Control round trip. The outstanding acceptance work is the separate-account test, existing-conversation migration, a real Claude restart that reclaims its runtime without an owner reset, and deployment-specific backup/restore operation.
