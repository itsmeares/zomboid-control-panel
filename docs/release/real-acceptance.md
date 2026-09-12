# Real release acceptance

The normal CI suite uses fake RCON, a fake Project Zomboid runtime, local
filesystem boundaries, and a packaged panel smoke test. That is useful fast
feedback, but it cannot prove that a release controls a real game server.

Run `.github/workflows/real-acceptance.yml` before an RC or stable release.
The workflow remains manually dispatchable for rehearsal, and is also called
by `release-artifacts.yml`; publication waits for every acceptance row.

The release workflow assumes each target environment has already been
updated with the exact artifact built from the release tag. The acceptance job
resolves that tag to one full commit SHA and rejects any target whose health
endpoint reports another SHA. Deployment is an environment operation because
the targets are private, disposable self-hosted machines; do not publish a
release until that deployment has completed.

## Matrix

| Row | Runner label | Deployment | Required target |
| --- | --- | --- | --- |
| Linux native | `self-hosted-linux-pz` | `native-linux` | Linux panel artifact, pinned PZ build, RCON, PanelBridge, SteamCMD |
| Windows native | `self-hosted-windows-pz` | `native-windows` | Windows panel artifact, pinned PZ build, RCON, PanelBridge, SteamCMD |
| Docker all-in-one | `self-hosted-linux-pz-docker` | `docker-all-in-one` | disposable Compose stack with persistent volumes and a pinned PZ build |

The panel URL in each GitHub Environment must point at the artifact built from
the selected ref. The workflow supplies the expected full commit SHA from its
immutable ref resolution; there is no operator-controlled expected SHA to
keep in environment variables.

For a panel-only remote deployment, run the script on a fourth self-hosted
runner with `ZCP_ACCEPTANCE_DEPLOYMENT=remote-rcon-sftp` and
`ZCP_ACCEPTANCE_REQUIRE_BRIDGE=1` if SFTP PanelBridge is part of the supported
configuration. Remote process start and stop are intentionally not required,
because the hosting provider owns that process.

## Target setup

Each GitHub Environment needs these variables:

- `ZCP_ACCEPTANCE_URL`
- `ZCP_ACCEPTANCE_OWNER`
- `ZCP_ACCEPTANCE_EXPECTED_PANEL_VERSION`
- `ZCP_ACCEPTANCE_PZ_BUILD_ID`
- `ZCP_ACCEPTANCE_PZ_INSTALL_PATH` on native and Docker runners
- `ZCP_ACCEPTANCE_SERVER_ID`
- `ZCP_ACCEPTANCE_REQUIRE_BRIDGE=1` for native and Docker release rows
- `ZCP_ACCEPTANCE_CORS_MODE`, set to `same-origin` or `cross-origin`
- `ZCP_ACCEPTANCE_CORS_ORIGIN` when CORS mode is `cross-origin`
- `ZCP_ACCEPTANCE_TEST_STEAMCMD=1` for native and all-in-one rows
- `ZCP_ACCEPTANCE_TEST_LIFECYCLE=1` for disposable native and Docker rows
- `ZCP_ACCEPTANCE_ALLOW_DESTRUCTIVE=1` for those lifecycle rows

Store only the disposable admin credentials as Environment secrets:

- `ZCP_ACCEPTANCE_USERNAME`
- `ZCP_ACCEPTANCE_PASSWORD`

The acceptance account and world must be disposable. Lifecycle checks stop and
start the server. The script never runs a world-changing RCON command. It uses
`players` as the live command probe.

## Checks

The runner checks the PZ app manifest, panel health and artifact SHA,
authentication rejection, API login, and managed-server discovery. It then
checks process status, live RCON health and command execution, console logs,
PanelBridge status and ping, CORS mode, and SteamCMD discovery and branch
lookup. The browser runner separately logs in through the real panel, proves a
successful TanStack Start server-function request, hard-reloads, and proves
that the protected dashboard and HttpOnly refresh cookie survive. Native and
Docker rows also stop and start the disposable server, then verify RCON and
PanelBridge recovery.

Release-gate rows fail closed when PanelBridge, CORS mode, the PZ install
identity, SteamCMD, or lifecycle evidence is missing. A non-gate/manual
diagnostic run may show explicit `SKIP` entries, but a skipped required row is
not a release pass. The lifecycle cleanup is armed before the stop request and
always attempts to restart the target after a stop was attempted.

The workflow also runs the static bridge and RCON audits. The engine signature
check uses `--require-fresh-manifest`, so a changed `PanelBridge.lua` cannot
silently pass against an old manifest. The checked-in manifest records the
source hash, Project Zomboid build ID, and jar hash used to generate it; when
the pinned PZ build changes, regenerate it with that exact server jar before
updating the acceptance environment. The gate also compares the manifest build
ID with `ZCP_ACCEPTANCE_PZ_BUILD_ID`, so a fresh manifest for the wrong PZ
build cannot pass.

Each row uploads a small JSON result under the workflow run. It contains no
password, token, cookie, or raw server log. Keep the operator's full logs in
the private environment if a failure needs investigation.

## Release rule

Do not call an RC usable until every required matrix row has a passing evidence
artifact tied to the same panel build SHA and PZ build ID. If a platform or
deployment is unsupported, record that decision in the release notes instead
of treating a skipped row as a pass.
