# Real release acceptance

The normal CI suite uses fake RCON, a fake Project Zomboid runtime, local
filesystem boundaries, and a packaged panel smoke test. That is useful fast
feedback, but it cannot prove that a release controls a real game server.

Run `.github/workflows/real-acceptance.yml` before an RC or stable release.
The workflow is manual because the targets need disposable Project Zomboid
installs and self-hosted runners.

## Matrix

| Row | Runner label | Deployment | Required target |
| --- | --- | --- | --- |
| Linux native | `self-hosted-linux-pz` | `native-linux` | Linux panel artifact, pinned PZ build, RCON, PanelBridge, SteamCMD |
| Windows native | `self-hosted-windows-pz` | `native-windows` | Windows panel artifact, pinned PZ build, RCON, PanelBridge, SteamCMD |
| Docker all-in-one | `self-hosted-linux-pz-docker` | `docker-all-in-one` | disposable Compose stack with persistent volumes and a pinned PZ build |

The panel URL in each GitHub Environment must point at the artifact built from
the selected ref. `ZCP_ACCEPTANCE_EXPECTED_BUILD_SHA` makes the runner reject a
target that is serving a different artifact.

For a panel-only remote deployment, run the script on a fourth self-hosted
runner with `ZCP_ACCEPTANCE_DEPLOYMENT=remote-rcon-sftp` and
`ZCP_ACCEPTANCE_REQUIRE_BRIDGE=1` if SFTP PanelBridge is part of the supported
configuration. Remote process start and stop are intentionally not required,
because the hosting provider owns that process.

## Target setup

Each GitHub Environment needs these variables:

- `ZCP_ACCEPTANCE_URL`
- `ZCP_ACCEPTANCE_OWNER`
- `ZCP_ACCEPTANCE_EXPECTED_BUILD_SHA`
- `ZCP_ACCEPTANCE_EXPECTED_PANEL_VERSION`
- `ZCP_ACCEPTANCE_PZ_BUILD_ID`, or `ZCP_ACCEPTANCE_PZ_INSTALL_PATH` on the runner
- `ZCP_ACCEPTANCE_SERVER_ID`
- `ZCP_ACCEPTANCE_REQUIRE_BRIDGE`, set to `1` or `0`
- `ZCP_ACCEPTANCE_CORS_ORIGIN` when the target is behind a reverse proxy
- `ZCP_ACCEPTANCE_TEST_STEAMCMD`, set to `1` for native and all-in-one rows
- `ZCP_ACCEPTANCE_TEST_LIFECYCLE`, set to `1` for disposable native and Docker rows
- `ZCP_ACCEPTANCE_ALLOW_DESTRUCTIVE`, set to `1` for those lifecycle rows

Store only the disposable admin credentials as Environment secrets:

- `ZCP_ACCEPTANCE_USERNAME`
- `ZCP_ACCEPTANCE_PASSWORD`

The acceptance account and world must be disposable. Lifecycle checks stop and
start the server. The script never runs a world-changing RCON command. It uses
`players` as the live command probe.

## Checks

The runner checks the PZ app manifest or the declared remote build ID, panel
health and artifact SHA, authentication rejection, login, refresh-cookie
session, managed-server discovery, process status, live RCON health and
command execution, console logs, PanelBridge status and ping, optional CORS,
and SteamCMD discovery and branch lookup. Native and Docker rows also stop and
start the disposable server, then verify RCON and PanelBridge recovery.

The workflow also runs the static bridge and RCON audits. The engine signature
check uses `--require-fresh-manifest`, so a changed `PanelBridge.lua` cannot
silently pass against an old manifest.

Each row uploads a small JSON result under the workflow run. It contains no
password, token, cookie, or raw server log. Keep the operator's full logs in
the private environment if a failure needs investigation.

## Release rule

Do not call an RC usable until every required matrix row has a passing evidence
artifact tied to the same panel build SHA and PZ build ID. If a platform or
deployment is unsupported, record that decision in the release notes instead
of treating a skipped row as a pass.
