# Upstream parity ledger

Last compared: 2026-09-11

Better ZCP is a long-lived fork, so commit-count parity is not a useful release
criterion. This ledger records the upstream revision inspected and the
behavior-level checks that matter to this fork.

## Reference

- Upstream repository: [fpsacha/zomboid-control-panel](https://github.com/fpsacha/zomboid-control-panel)
- Inspected upstream commit: [97f8a8c8d3fbd7de01ca6f87f7c1d190f0c69c47](https://github.com/fpsacha/zomboid-control-panel/commit/97f8a8c8d3fbd7de01ca6f87f7c1d190f0c69c47)
- Common ancestor used for the comparison: `c8438298cdc56c845beed73b68f04fb140372e2a`

## Behavior ledger

| Upstream area | Better ZCP status | Evidence or limit |
| --- | --- | --- |
| Deactivated mod tracking and updates | Present | Mods capability and deactivated-tracking tests cover the public workflow. |
| Support diagnostics | Present | Debug/support routes and client diagnostics flows are retained; no live host was available for an operational check. |
| Workshop IDs and mod metadata with spacing/edge formatting | Present | Mod parsing and public route coverage remain in the fork; keep edge fixtures when upstream changes this area. |
| SteamCMD recovery and concurrent operation guards | Present | Fake-process and operation-lock tests cover refusal, cleanup, and recovery behavior. |
| Discord configuration and serialized status | Present | Integration route/client tests cover configuration and response shape. |
| Atomic backup/restore behavior | Present | Backup/template and restore safety tests cover partial failure and secret handling. |
| Managed lifecycle guards | Present | Lifecycle lock, provider, and start/stop route tests cover ownership and race prevention. |

## Release decision

This is not a claim that Better ZCP is byte-for-byte or commit-for-commit
current with upstream. It is a documented behavioral comparison against the
inspected SHA. Before each future release, compare the new upstream head,
append changed behavior here, and add a regression test for every adopted fix.

Real Project Zomboid, RCON, SteamCMD, Windows, and remote transport acceptance
run through the [real acceptance runbook](release/real-acceptance.md). This
repository run still uses controlled fakes and local filesystem/network
boundaries for fast CI.
