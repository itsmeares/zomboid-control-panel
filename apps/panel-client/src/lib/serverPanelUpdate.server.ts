import { createServerFn } from '@tanstack/react-start'
import {
  adminRoleMiddleware,
  protectedServerFunctionMiddleware,
} from './serverAuth.server'

type AnyRecord = Record<string, any>

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function throwPanelError(error: unknown, fallbackStatus: number): never {
  const details = error && typeof error === 'object'
    ? error as AnyRecord
    : {}
  throw Object.assign(new Error(errorMessage(error)), {
    status: typeof details.status === 'number' ? details.status : fallbackStatus,
    ...(typeof details.code === 'string' ? { code: details.code } : {}),
    ...(details.params !== undefined ? { params: details.params } : {}),
    ...(details.success !== undefined ? { success: details.success } : {}),
  })
}

async function panelRuntime(): Promise<AnyRecord> {
  const { getPanelRuntime } =
    await import('../../../panel-server/utils/panelRuntime.ts')
  return getPanelRuntime()
}

async function checkPanelUpdateImplementation() {
  try {
    const checker = (await panelRuntime()).panelUpdateChecker
    if (!checker) throw new Error('Panel update checker not available')
    return await checker.checkForUpdate()
  } catch (error) {
    throwPanelError(error, 500)
  }
}

export const checkPanelUpdate = createServerFn({ method: 'GET' })
  .middleware(protectedServerFunctionMiddleware)
  .handler(checkPanelUpdateImplementation)
;(checkPanelUpdate as any).__executeImplementation =
  checkPanelUpdateImplementation

async function getPanelUpdateStatusImplementation() {
  try {
    const checker = (await panelRuntime()).panelUpdateChecker
    if (!checker) throw new Error('Panel update checker not available')
    return checker.getStatus()
  } catch (error) {
    throwPanelError(error, 500)
  }
}

export const getPanelUpdateStatus = createServerFn({ method: 'GET' })
  .middleware(protectedServerFunctionMiddleware)
  .handler(getPanelUpdateStatusImplementation)
;(getPanelUpdateStatus as any).__executeImplementation =
  getPanelUpdateStatusImplementation

async function getPanelUpdatePreflightImplementation() {
  try {
    const checker = (await panelRuntime()).panelUpdateChecker
    if (!checker) throw new Error('Panel update checker not available')
    return await checker.preflight()
  } catch (error) {
    throwPanelError(error, 500)
  }
}

export const getPanelUpdatePreflight = createServerFn({ method: 'GET' })
  .middleware(protectedServerFunctionMiddleware)
  .handler(getPanelUpdatePreflightImplementation)
;(getPanelUpdatePreflight as any).__executeImplementation =
  getPanelUpdatePreflightImplementation

async function getPanelUpdateApplyLogImplementation() {
  try {
    const runtime = await panelRuntime()
    const checker = runtime.panelUpdateChecker
    if (!checker) throw new Error('Panel update checker not available')
    const { getDataPaths } =
      await import('../../../panel-server/utils/paths.ts')
    return {
      log: checker.readMostRecentApplyLog(),
      logPath: `${getDataPaths().logsDir}/panel-update-last.log`,
    }
  } catch (error) {
    throwPanelError(error, 500)
  }
}

export const getPanelUpdateApplyLog = createServerFn({ method: 'GET' })
  .middleware(protectedServerFunctionMiddleware)
  .handler(getPanelUpdateApplyLogImplementation)
;(getPanelUpdateApplyLog as any).__executeImplementation =
  getPanelUpdateApplyLogImplementation

async function downloadPanelUpdateImplementation(
  data: { confirm?: unknown },
) {
    try {
      const runtime = await panelRuntime()
      const checker = runtime.panelUpdateChecker
      if (!checker) throw new Error('Panel update checker not available')

      if (checker.dockerUpdateProxy?.enabled) {
        if (data.confirm !== true) {
          throwPanelError(
            Object.assign(
              new Error(
                'Confirm the Docker update before recreating the all-in-one container.',
              ),
              { code: 'confirmation_required' },
            ),
            400,
          )
        }

        const processDetails =
          typeof runtime.serverManager?.getServerProcessDetails === 'function'
            ? await runtime.serverManager.getServerProcessDetails()
            : null
        if (!processDetails || processDetails.scanFailed) {
          throwPanelError(
            Object.assign(
              new Error(
                "Can't verify whether the server is stopped because process detection failed. The Docker update was not started.",
              ),
              { code: 'SERVER_STATE_UNKNOWN' },
            ),
            503,
          )
        }

        if (processDetails.running) {
          const rconService = runtime.rconService
          if (!rconService?.connected) {
            throwPanelError(
              Object.assign(
                new Error(
                  'Stop the Project Zomboid server before applying a Docker update. RCON is not connected, so the panel cannot safely stop it for you.',
                ),
                { code: 'SERVER_RUNNING_RCON_UNAVAILABLE' },
              ),
              409,
            )
          }

          const saved = await rconService.save()
          if (!saved?.success) {
            const reason = saved?.error || 'unknown error'
            throwPanelError(
              Object.assign(
                new Error(
                  `The world could not be saved (${reason}), so the server was left running. Applying the update now would lose everything since the last save.`,
                ),
                { code: 'save_failed', params: { reason } },
              ),
              409,
            )
          }
          const quit = await rconService.quit()
          if (!quit?.success) {
            const reason = quit?.error || 'unknown error'
            throwPanelError(
              Object.assign(
                new Error(
                  `The world was saved, but the server could not be shut down (${reason}). It is still running, so the update was not applied.`,
                ),
                { code: 'stop_failed', params: { reason } },
              ),
              502,
            )
          }
          const { logServerEvent } =
            await import('../../../panel-server/database/init.ts')
          await logServerEvent(
            'server_stop',
            'Server stopped before Docker panel update',
          )
        }
      }

      const result = await checker.downloadUpdate()
      if (!result.success) {
        throwPanelError(
          Object.assign(new Error(result.error || result.message || 'Panel update failed'), result),
          result.code === 'already_downloading' ? 409 : 400,
        )
      }
      return result
    } catch (error) {
      throwPanelError(error, 500)
    }
}

export const downloadPanelUpdate = createServerFn({ method: 'POST' })
  .middleware(adminRoleMiddleware)
  .validator((data: { confirm?: unknown } | undefined) => data ?? {})
  .handler(({ data }) => downloadPanelUpdateImplementation(data))
;(downloadPanelUpdate as any).__executeImplementation =
  downloadPanelUpdateImplementation

async function restartPanelImplementation() {
    const runtime = await panelRuntime()
    const checker = runtime.panelUpdateChecker
    if (!checker) throwPanelError(new Error('Panel update checker not available'), 500)

    const fs = await import('node:fs')
    const processModule = await import('node:process')
    const { spawn } = await import('node:child_process')
    const { createUpdateDataBackup } =
      await import('../../../panel-server/services/panelUpdateChecker.ts')
    const {
      applyUpdateBundle,
      recoverInterruptedUpdateBundle,
    } = await import('../../../panel-server/services/updateBundle.ts')
    const { getDataPaths } =
      await import('../../../panel-server/utils/paths.ts')
    const {
      getDatabaseFilePath,
      setSetting,
      flushWrites,
    } = await import('../../../panel-server/database/init.ts')
    const { isLinuxPanelSupervisor } =
      await import('../../../panel-server/utils/restartSupervisor.ts')

    const staged = checker.getStagedUpdate?.() || null
    const isPackaged = typeof process.pkg !== 'undefined'
    const isWindows = process.platform === 'win32'

    if (isPackaged && staged) {
      try {
        const dataBackupPath = createUpdateDataBackup(
          { ...getDataPaths(), dbPath: getDatabaseFilePath() },
          staged.version,
        )
        if (dataBackupPath) {
          await setSetting('preUpdateDataBackupPath', dataBackupPath)
          await flushWrites()
        }
      } catch {
        // The update path remains usable when the best-effort snapshot cannot be made.
      }
    }

    if (isPackaged && isWindows && staged) {
      if (checker.isSupervisorAvailable?.()) {
        if (checker.isApplying) {
          throwPanelError(
            Object.assign(new Error('An update apply is already in progress.'), {
              code: 'apply_in_progress',
            }),
            409,
          )
        }
        checker.isApplying = true
        if (staged.version) {
          await setSetting('pendingPanelUpdate', staged.version)
          await flushWrites()
        }
        checker.writeSupervisorMarker(staged)
        setTimeout(() => processModule.exit(75), 500)
        return {
          success: true,
          message: 'Stopping panel for supervisor to apply update...',
          applyingUpdate: true,
          supervisor: true,
        }
      }
      checker.isApplying = false
      throwPanelError(
        new Error(
          'This update requires the packaged Start.bat supervisor. Stop the panel and launch Start.bat, then apply again.',
        ),
        409,
      )
    }

    let linuxRespawnPath: string | null = null
    if (isPackaged && !isWindows && staged) {
      if (checker.isApplying) {
        throwPanelError(
          Object.assign(new Error('An update apply is already in progress.'), {
            code: 'apply_in_progress',
          }),
          409,
        )
      }
      checker.isApplying = true
      try {
        if (staged.version) {
          await setSetting('pendingPanelUpdate', staged.version)
          await flushWrites()
        }
        const appliedBundle = applyUpdateBundle(staged.journalPath)
        const targetPath = appliedBundle.paths.binary
        await fs.promises.chmod(targetPath, 0o755).catch(() => {})
        try {
          await fs.promises.access(targetPath, fs.constants.X_OK)
        } catch (error) {
          recoverInterruptedUpdateBundle(staged.journalPath, 'binary_not_executable')
          checker.isApplying = false
          throwPanelError(
            new Error(`Applied update is not executable: ${errorMessage(error)}`),
            500,
          )
        }
        linuxRespawnPath = targetPath
      } catch (error) {
        checker.isApplying = false
        throwPanelError(error, 500)
      }
    }

    setTimeout(async () => {
      await flushWrites().catch(() => {})
      const linuxSupervisor = isLinuxPanelSupervisor()
      let orchestrated = false
      if (isPackaged) {
        orchestrated = Boolean(
          process.env.INVOCATION_ID ||
          process.env.NOTIFY_SOCKET ||
          fs.existsSync('/.dockerenv') ||
          fs.existsSync('/run/.containerenv'),
        )
        if (!orchestrated && !linuxSupervisor) {
          spawn(linuxRespawnPath || process.execPath, [], {
            detached: true,
            stdio: 'ignore',
          }).unref()
        }
      }
      processModule.exit(linuxSupervisor ? 75 : orchestrated ? 1 : 0)
    }, 1000)

    return { success: true, message: 'Panel is restarting...' }
}

export const restartPanel = createServerFn({ method: 'POST' })
  .middleware(adminRoleMiddleware)
  .handler(restartPanelImplementation)
;(restartPanel as any).__executeImplementation = restartPanelImplementation

export function classifyStartupProcessState(
  processState: AnyRecord | null | undefined,
  isRemote = false,
) {
  if (isRemote) return { running: Boolean(processState?.running), unknown: false }
  if (!processState || processState.scanFailed || typeof processState.running !== 'boolean') {
    return { running: false, unknown: true }
  }
  return { running: processState.running, unknown: false }
}
