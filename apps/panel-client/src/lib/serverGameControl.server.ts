/* eslint-disable @typescript-eslint/triple-slash-reference */
/// <reference path="../../../panel-server/types/globals.d.ts" />
/// <reference path="../../../panel-server/types/sql-js.d.ts" />

import { createServerFn } from '@tanstack/react-start'
import { setResponseStatus } from '@tanstack/react-start/server'
import type { ScheduleHistoryEntry, SchedulerStatus } from './api'
import {
  permissionMiddleware,
  protectedServerFunctionMiddleware,
} from './serverAuth.server'

type ServiceError = {
  error?: unknown
  message?: unknown
  code?: unknown
  params?: unknown
  status?: unknown
  details?: unknown
  success?: unknown
  valid?: unknown
  detail?: unknown
  reason?: unknown
}

type AnyRecord = Record<string, any>

async function panelRuntime(): Promise<AnyRecord> {
  const { getPanelRuntime } =
    await import('../../../panel-server/utils/panelRuntime.ts')
  return getPanelRuntime()
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object') {
    const details = error as ServiceError
    if (typeof details.error === 'string') return details.error
    if (typeof details.message === 'string') return details.message
  }
  return String(error)
}

function throwControlError(error: unknown, fallbackStatus = 500): never {
  const details =
    error && typeof error === 'object' ? (error as ServiceError) : {}
  const status =
    typeof details.status === 'number' ? details.status : fallbackStatus
  const extraDetails =
    details.details &&
    typeof details.details === 'object' &&
    !Array.isArray(details.details)
      ? details.details
      : {}
  const safeError = Object.assign(new Error(errorMessage(error)), {
    status,
    ...(typeof details.code === 'string' ? { code: details.code } : {}),
    ...(details.params !== undefined ? { params: details.params } : {}),
    ...(details.success === false ? { success: false } : {}),
    ...(details.valid === false ? { valid: false } : {}),
    ...(typeof details.detail === 'string' ? { detail: details.detail } : {}),
    ...(typeof details.reason === 'string' ? { reason: details.reason } : {}),
    ...extraDetails,
  })
  throw safeError
}

function invalid(message: string, code?: string, params?: unknown): never {
  throwControlError(
    Object.assign(new Error(message), {
      ...(code ? { code } : {}),
      ...(params !== undefined ? { params } : {}),
    }),
    400,
  )
}

function capabilityMiddleware(capability: string | string[]) {
  const capabilities = Array.isArray(capability) ? capability : [capability]
  return [
    ...protectedServerFunctionMiddleware,
    ...capabilities.map(permissionMiddleware),
  ] as const
}

function record(data: unknown): AnyRecord {
  return data && typeof data === 'object' && !Array.isArray(data)
    ? (data as AnyRecord)
    : {}
}

function requiredString(
  data: AnyRecord,
  key: string,
  message: string,
  code?: string,
): string {
  const value = data[key]
  if (typeof value !== 'string' || !value.trim()) invalid(message, code)
  return value.trim()
}

function validUsername(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.trim().length <= 64 &&
    // eslint-disable-next-line no-control-regex
    /^[^\x00-\x1F\x7F"\\]+$/.test(value.trim())
  )
}

function validText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[a-zA-Z0-9\s.,!?'":;()@#&+=%_\-\u00C0-\u024F]{0,256}$/.test(value)
  )
}

function validNumber(value: unknown, min = -Infinity, max = Infinity): boolean {
  if (
    value === null ||
    value === undefined ||
    (typeof value === 'string' && value.trim() === '')
  ) {
    return false
  }
  const number = Number(value)
  return Number.isFinite(number) && number >= min && number <= max
}

function optionalEventUsername(data: AnyRecord): string | undefined {
  const username = data.username
  if (username && (typeof username !== 'string' || username.length > 64)) {
    invalid('Invalid username', 'EVENTS_INVALID_USERNAME')
  }
  return username || undefined
}

function legacyIntegerOrDefault(
  value: unknown,
  min: number,
  max: number,
  fallback: number | null,
): number | null {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isNaN(parsed) || parsed < min || parsed > max
    ? fallback
    : parsed
}

async function assertCapability(
  context: AnyRecord,
  capability: string,
): Promise<void> {
  const user = context.authenticatedUser
  const { getCapabilitiesForRole } =
    await import('../../../panel-server/services/permissions.ts')
  const capabilities = await getCapabilitiesForRole(user.role)
  if (!capabilities?.includes(capability)) {
    throwControlError(
      Object.assign(new Error('Insufficient permissions'), {
        code: 'PERMISSION_DENIED',
      }),
      403,
    )
  }
}

function createControlRead<T>(
  capability: string | null,
  handler: (data: AnyRecord) => Promise<T> | T,
) {
  const serverFn = createServerFn({ method: 'GET' })
  const secured = capability
    ? serverFn.middleware(capabilityMiddleware(capability))
    : serverFn.middleware(protectedServerFunctionMiddleware)
  const implementation = async (data: AnyRecord): Promise<T> => {
    try {
      return (await handler(data)) as T
    } catch (error) {
      throwControlError(error)
    }
  }
  return Object.assign(
    secured
      .validator((data: unknown) => record(data))
      .handler(({ data }) => implementation(data) as any),
    { __executeImplementation: implementation },
  )
}

function createControlAction<T>(
  capability: string | string[],
  handler: (
    runtime: AnyRecord,
    data: AnyRecord,
    context: AnyRecord,
  ) => Promise<T> | T,
) {
  const implementation = async (
    data: AnyRecord,
    context: AnyRecord,
  ): Promise<T> => {
    try {
      return (await handler(await panelRuntime(), data, context)) as T
    } catch (error) {
      throwControlError(error)
    }
  }
  return Object.assign(
    createServerFn({ method: 'POST' })
      .middleware(capabilityMiddleware(capability))
      .validator((data: unknown) => record(data))
      .handler(({ data, context }) =>
        implementation(data, context as unknown as AnyRecord) as any,
      ),
    { __executeImplementation: implementation },
  )
}

export const getGameServerStatus = createControlRead(null, async () => {
  const runtime = await panelRuntime()
  const [
    { buildServerSignal, resolveLifecycleState },
    { getActiveLifecycleOperation },
  ] = await Promise.all([
    import('../../../panel-server/utils/serverStatusModel.ts'),
    import('../../../panel-server/services/lifecycleCoordinator.ts'),
  ])
  const status = await runtime.serverManager.getServerStatus()
  const rconStatus = runtime.rconService.getConfig()
  const serverSignal = buildServerSignal({
    connected: rconStatus.connected,
    connecting: Boolean(
      runtime.rconService.connecting || runtime.rconService.reconnecting,
    ),
  })
  return {
    ...status,
    rcon: rconStatus,
    state: resolveLifecycleState({
      hostStatus: status.scanFailed
        ? 'unknown'
        : status.running
          ? 'running'
          : 'stopped',
      rconStatus: serverSignal.status,
      operation: getActiveLifecycleOperation(),
    }),
  }
})

export const getNetworkInterfaces = createControlRead(null, async () => {
  const runtime = await panelRuntime()
  return { interfaces: runtime.serverManager.listNetworkInterfaces() }
})

export const getManagedServers = createControlRead(null, async () => {
  const { getServers, getAllSettings } =
    await import('../../../panel-server/database/init.ts')
  const { withRemoteConfigState } =
    await import('../../../panel-server/utils/managedServerResponse.ts')
  const { sanitizeServerResponseList } =
    await import('../../../panel-server/utils/sanitize.ts')
  const { getLinuxLifecycleCapabilities } =
    await import('../../../panel-server/services/linuxServiceLifecycle.ts')
  const settings = await getAllSettings()
  return {
    servers: sanitizeServerResponseList(
      (await getServers()).map((server: AnyRecord) =>
        withRemoteConfigState(server, settings),
      ),
    ),
    lifecycleCapabilities: getLinuxLifecycleCapabilities(),
  }
})

export const getActiveManagedServer = createControlRead(null, async () => {
  const { getActiveServer, getAllSettings } =
    await import('../../../panel-server/database/init.ts')
  const { withRemoteConfigState } =
    await import('../../../panel-server/utils/managedServerResponse.ts')
  const { sanitizeServerResponse } =
    await import('../../../panel-server/utils/sanitize.ts')
  const server = await getActiveServer()
  if (!server)
    throwControlError(
      Object.assign(new Error('No active server configured'), { status: 404 }),
      404,
    )
  const settings = await getAllSettings()
  return {
    server: sanitizeServerResponse(withRemoteConfigState(server, settings)),
  }
})

export const getManagedServer = createControlRead(null, async (data) => {
  const id = requiredString(data, 'id', 'Invalid server ID')
  const [{ getServer }, { parseServerId }] = await Promise.all([
    import('../../../panel-server/database/init.ts'),
    import('../../../panel-server/services/serverProfiles.ts'),
  ])
  const serverId = parseServerId(id)
  if (serverId === null) invalid('Invalid server ID')
  const { sanitizeServerResponse } =
    await import('../../../panel-server/utils/sanitize.ts')
  const server = await getServer(serverId)
  if (!server)
    throwControlError(
      Object.assign(new Error('Server not found'), { status: 404 }),
      404,
    )
  return { server: sanitizeServerResponse(server) }
})

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<R> | R,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let nextIndex = 0
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex++
        results[index] = await mapper(items[index])
      }
    },
  )
  await Promise.all(workers)
  return results
}

export const getManagedServersStatus = createControlRead(null, async () => {
  const [
    { getServers, getActiveServer },
    { createLinuxServiceLifecycle, isManagedLifecycleProvider },
    { sanitizeError },
  ] = await Promise.all([
    import('../../../panel-server/database/init.ts'),
    import('../../../panel-server/services/linuxServiceLifecycle.ts'),
    import('../../../panel-server/utils/sanitize.ts'),
  ])
  const runtime = await panelRuntime()
  const servers = (await getServers()) as AnyRecord[]
  const activeServer = await getActiveServer()
  const activeId = activeServer?.id ?? null
  let matched: AnyRecord[] = []
  let detectionError: string | null = null

  if (runtime.serverManager?.getServerProcessDetails) {
    try {
      const result = await runtime.serverManager.getServerProcessDetails()
      matched = Array.isArray(result?.matched) ? result.matched : []
      if (result?.scanFailed)
        detectionError = result.error || 'Process detection failed'
    } catch (error) {
      detectionError = errorMessage(error)
    }
  }

  const normalizePath = (value: unknown) =>
    String(value || '')
      .toLowerCase()
      .replace(/\\/g, '/')
      .trim()
  const statuses = await Promise.all(
    servers.map(async (server) => {
      if (isManagedLifecycleProvider(server.lifecycleProvider)) {
        try {
          const status = await createLinuxServiceLifecycle(
            server as Parameters<typeof createLinuxServiceLifecycle>[0],
            server.lifecycleProvider,
          ).status()
          return {
            id: server.id,
            name: server.name,
            running: status.running,
            pid: null,
            isActive: server.id === activeId,
            provider: server.lifecycleProvider,
            stateUnknown: Boolean(status.scanFailed),
          }
        } catch (error) {
          return {
            id: server.id,
            name: server.name,
            running: false,
            pid: null,
            isActive: server.id === activeId,
            provider: server.lifecycleProvider,
            stateUnknown: true,
            error: sanitizeError(errorMessage(error)),
          }
        }
      }

      const installPath = normalizePath(server.installPath)
      const process = installPath
        ? matched.find((entry) =>
            normalizePath(entry.cmd).includes(installPath),
          )
        : undefined
      const running =
        Boolean(process) ||
        (server.id === activeId && runtime.serverManager?.isRunning)
      return {
        id: server.id,
        name: server.name,
        running,
        pid: process?.pid || null,
        isActive: server.id === activeId,
        provider: 'direct',
        stateUnknown: Boolean(detectionError),
      }
    }),
  )

  return {
    servers: statuses,
    detectedProcesses: matched.length,
    detectionError,
  }
})

export const getManagedServersRconStatus = createControlRead(null, async () => {
  const [{ getServers }, { testRconConnection }, { parseBoundedInteger }] =
    await Promise.all([
      import('../../../panel-server/database/init.ts'),
      import('../../../panel-server/services/rcon.ts'),
      import('../../../panel-server/utils/queryNumbers.ts'),
    ])
  const servers = (await getServers()) as AnyRecord[]
  const statuses = await mapWithConcurrency(servers, 3, async (server) => {
    const host =
      typeof server.rconHost === 'string' ? server.rconHost.trim() : ''
    const port = parseBoundedInteger(server.rconPort, null, 1, 65535)
    if (
      !host ||
      server.rconPort === undefined ||
      server.rconPort === null ||
      server.rconPort === ''
    ) {
      return { id: server.id, status: 'unconfigured' }
    }
    if (port === null) return { id: server.id, status: 'unavailable' }
    const result = await testRconConnection({
      host,
      port,
      password: server.rconPassword || '',
      timeoutMs: 3000,
    })
    return {
      id: server.id,
      status: result.success ? 'connected' : result.error || 'unavailable',
    }
  })
  return { servers: statuses }
})

export const getActiveComposedStatus = createControlRead(null, async () => {
  const [
    { getActiveServer },
    { composeServerStatus, resolveProvider },
    { resolveDockerHostSignal },
    { getActiveLifecycleOperation },
  ] = await Promise.all([
    import('../../../panel-server/database/init.ts'),
    import('../../../panel-server/utils/serverStatusModel.ts'),
    import('../../../panel-server/services/managedContainer.ts'),
    import('../../../panel-server/services/lifecycleCoordinator.ts'),
  ])
  const runtime = await panelRuntime()
  const server = await getActiveServer()
  if (!server) {
    throwControlError(
      Object.assign(new Error('No active server configured'), { status: 404 }),
      404,
    )
  }

  const provider = resolveProvider(server)
  const isContainerProvider =
    provider === 'docker-local' || provider === 'docker-managed'
  let processDetails: AnyRecord
  let dockerContainer: AnyRecord | null = null
  if (isContainerProvider) {
    const dockerSignal = await resolveDockerHostSignal(
      server,
      runtime.dockerClient,
    )
    processDetails = dockerSignal
    dockerContainer = dockerSignal.scanFailed
      ? { handled: true, error: 'Docker container status unavailable' }
      : { handled: true, running: dockerSignal.running }
  } else {
    processDetails =
      typeof runtime.serverManager?.getServerProcessDetails === 'function'
        ? await runtime.serverManager.getServerProcessDetails()
        : { running: !!runtime.serverManager?.isRunning, scanFailed: false }
  }

  const rconService = runtime.rconService
  const rconConfig = rconService?.getConfig ? rconService.getConfig() : {}
  const bridge = runtime.panelBridge
  return composeServerStatus({
    server,
    isRunning: !!processDetails.running,
    scanFailed: !!processDetails.scanFailed,
    dockerContainer,
    rcon: {
      ...rconConfig,
      connecting: !!(rconService?.connecting || rconService?.reconnecting),
    },
    bridge: {
      configured: !!bridge?.bridgePath,
      running: !!bridge?.isRunning,
      modConnected: bridge?.isModConnected ? bridge.isModConnected() : false,
    },
    lifecycleOperation: getActiveLifecycleOperation(),
  })
})

export const createManagedServer = createControlAction(
  'servers.manage',
  async (_runtime, data, context) => {
    const allowIniImport =
      data.importIniFrom && typeof data.importIniFrom === 'object'
    if (allowIniImport) await assertCapability(context, 'servers.discover')
    const { createServerProfile } =
      await import('../../../panel-server/services/serverProfiles.ts')
    const { sanitizeServerResponse } =
      await import('../../../panel-server/utils/sanitize.ts')
    const server = await createServerProfile(data, { allowIniImport: true })
    setResponseStatus(201)
    return {
      server: sanitizeServerResponse(server),
      message: 'Server created successfully',
    }
  },
)

export const updateManagedServer = createControlAction(
  'servers.manage',
  async (runtime, data) => {
    const { updateServerProfile } =
      await import('../../../panel-server/services/serverProfiles.ts')
    const { sanitizeServerResponse } =
      await import('../../../panel-server/utils/sanitize.ts')
    const result = await updateServerProfile(data.id, data.updates, runtime)
    return {
      ...result,
      server: sanitizeServerResponse(result.server),
    }
  },
)

export const deleteManagedServer = createControlAction(
  'servers.manage',
  async (runtime, data) => {
    const { deleteServerProfile } =
      await import('../../../panel-server/services/serverProfiles.ts')
    return deleteServerProfile(data.id, runtime)
  },
)

export const activateManagedServer = createControlAction(
  'servers.manage',
  async (runtime, data) => {
    const { activateServerProfile } =
      await import('../../../panel-server/services/serverProfiles.ts')
    const { sanitizeServerResponse } =
      await import('../../../panel-server/utils/sanitize.ts')
    const result = await activateServerProfile(data.id, runtime)
    return {
      ...result,
      server: sanitizeServerResponse(result.server),
    }
  },
)

export const getLifecycleTemplate = createControlRead(
  'servers.manage',
  async (data) => {
    const { getLifecycleTemplateForServer } =
      await import('../../../panel-server/services/serverProfiles.ts')
    return getLifecycleTemplateForServer(
      data.id,
      data.provider,
      data.serviceUser,
    )
  },
)

export const activateManagedLifecycleProvider = createControlAction(
  'servers.manage',
  async (runtime, data) => {
    const { activateLifecycleProvider } =
      await import('../../../panel-server/services/serverProfiles.ts')
    const { sanitizeServerResponse } =
      await import('../../../panel-server/utils/sanitize.ts')
    const result = await activateLifecycleProvider(
      data.id,
      data.provider,
      data.confirm,
      runtime,
    )
    return {
      ...result,
      server: sanitizeServerResponse(result.server),
    }
  },
)

export const getDiscoveredMounts = createControlRead(
  'servers.discover',
  async () => {
    const { discoverMountsForServer } =
      await import('../../../panel-server/services/serverProfiles.ts')
    return discoverMountsForServer()
  },
)

export const createServerFromDiscovery = createControlAction(
  'servers.discover',
  async (_runtime, data) => {
    const { createServerFromDiscovery: createFromDiscovery } =
      await import('../../../panel-server/services/serverProfiles.ts')
    const { sanitizeServerResponse } =
      await import('../../../panel-server/utils/sanitize.ts')
    const server = await createFromDiscovery(data)
    setResponseStatus(201)
    return {
      server: sanitizeServerResponse(server),
      message: 'Server created from discovered mount',
    }
  },
)

export const saveGameWorld = createControlAction('server.control', (runtime) =>
  runtime.rconService.save(),
)
export const startServer = createControlAction(
  'server.control',
  async (runtime, data) => {
    const { startServerAction } =
      await import('../../../panel-server/services/serverLifecycleActions.ts')
    return startServerAction(runtime, data)
  },
)

export const stopServer = createControlAction(
  'server.control',
  async (runtime, data) => {
    const { stopServerAction } =
      await import('../../../panel-server/services/serverLifecycleActions.ts')
    return stopServerAction(runtime, data)
  },
)

export const forceStopServer = createControlAction(
  'server.control',
  async (runtime, data) => {
    const { forceStopServerAction } =
      await import('../../../panel-server/services/serverLifecycleActions.ts')
    return forceStopServerAction(runtime, data)
  },
)

export const restartServer = createControlAction(
  'server.control',
  async (runtime, data) => {
    const { restartServerAction } =
      await import('../../../panel-server/services/serverLifecycleActions.ts')
    return restartServerAction(runtime, data)
  },
)

export const sendServerMessage = createControlAction(
  'server.world_events',
  (runtime, data) => {
    const message = data.message
    if (!message) invalid('Message is required', 'SERVER_MESSAGE_REQUIRED')
    if (typeof message !== 'string' || message.length > 1000) {
      invalid(
        'Message must be a string under 1000 characters',
        'SERVER_MESSAGE_TOO_LONG',
      )
    }
    return runtime.rconService.serverMessage(message.replace(/[\r\n]/g, ' '))
  },
)

export const startRain = createControlAction(
  'server.world_events',
  (runtime, data) => runtime.rconService.startRain(data.intensity),
)
export const stopRain = createControlAction('server.world_events', (runtime) =>
  runtime.rconService.stopRain(),
)
export const startStorm = createControlAction(
  'server.world_events',
  (runtime, data) => runtime.rconService.startStorm(data.duration),
)
export const stopWeather = createControlAction(
  'server.world_events',
  (runtime) => runtime.rconService.stopWeather(),
)
export const triggerChopper = createControlAction(
  'server.world_events',
  (runtime) => runtime.rconService.triggerChopper(),
)
export const triggerGunshot = createControlAction(
  'server.world_events',
  (runtime) => runtime.rconService.triggerGunshot(),
)
export const triggerLightning = createControlAction(
  'players.endanger_or_impersonate',
  (runtime, data) =>
    runtime.rconService.triggerLightning(optionalEventUsername(data)),
)
export const triggerThunder = createControlAction(
  'players.endanger_or_impersonate',
  (runtime, data) =>
    runtime.rconService.triggerThunder(optionalEventUsername(data)),
)
export const createHorde = createControlAction(
  'players.endanger_or_impersonate',
  (runtime, data) =>
    runtime.rconService.createHorde(
      legacyIntegerOrDefault(data.count, 1, 500, 50),
      optionalEventUsername(data),
    ),
)
export const alarm = createControlAction('server.world_events', (runtime) =>
  runtime.rconService.alarm(),
)
export const removeZombies = createControlAction(
  'server.world_events',
  (runtime) => runtime.rconService.removeZombies(),
)
export const reloadLua = createControlAction(
  'server.configure',
  (runtime, data) => {
    const filename = requiredString(
      data,
      'filename',
      'Filename is required',
      'RELOAD_LUA_FILENAME_REQUIRED',
    )
    if (!/^[a-zA-Z0-9_/.\-]+\.lua$/.test(filename) || filename.includes('..')) {
      invalid('Invalid filename format', 'RELOAD_LUA_INVALID_FILENAME')
    }
    return runtime.rconService.reloadLua(filename)
  },
)
export const setLogLevel = createControlAction(
  'server.configure',
  (runtime, data) => {
    const type = requiredString(
      data,
      'type',
      'Type and level are required',
      'LOG_TYPE_LEVEL_REQUIRED',
    )
    const level = requiredString(
      data,
      'level',
      'Type and level are required',
      'LOG_TYPE_LEVEL_REQUIRED',
    )
    const validTypes = [
      'General',
      'Network',
      'Multiplayer',
      'Voice',
      'Packet',
      'NetworkFileDebug',
      'Lua',
      'Mod',
      'Sound',
      'Zombie',
      'Combat',
      'Objects',
      'Fireplace',
      'Radio',
      'MapLoading',
      'Clothing',
      'Animation',
      'Asset',
      'Script',
      'Shader',
      'Input',
      'Recipe',
      'ActionSystem',
      'IsoRegion',
      'UniTests',
      'FileIO',
      'Ownership',
      'Death',
      'Damage',
      'Statistic',
      'Vehicle',
      'Checksum',
    ]
    const validLevels = ['Trace', 'Debug', 'General', 'Warning', 'Error']
    if (!validTypes.includes(type)) {
      invalid(
        `Invalid log type. Valid: ${validTypes.join(', ')}`,
        'LOG_INVALID_TYPE',
      )
    }
    if (!validLevels.includes(level)) {
      invalid(
        `Invalid log level. Valid: ${validLevels.join(', ')}`,
        'LOG_INVALID_LEVEL',
      )
    }
    return runtime.rconService.setLogLevel(type, level)
  },
)
export const setServerStats = createControlAction(
  'server.configure',
  (runtime, data) => {
    const mode = requiredString(
      data,
      'mode',
      'Mode is required',
      'STATS_MODE_REQUIRED',
    )
    const validModes = ['none', 'file', 'console', 'all']
    const normalizedMode = mode.toLowerCase()
    if (!validModes.includes(normalizedMode)) {
      invalid(
        `Invalid mode. Valid: ${validModes.join(', ')}`,
        'STATS_INVALID_MODE',
      )
    }
    const period = data.period
      ? legacyIntegerOrDefault(data.period, 1, 3600, null)
      : null
    return runtime.rconService.setStats(normalizedMode, period)
  },
)
export const releaseSafehouse = createControlAction(
  'server.world_events',
  (runtime) => runtime.rconService.releaseSafehouse(),
)

export const getPlayers = createControlRead('players.view', async () => {
  const runtime = await panelRuntime()
  const result = await runtime.rconService.getPlayers()
  if (result?.success)
    runtime.io?.to?.('players')?.emit?.('players:update', result.players)
  return result
})

export const getWhitelist = createControlRead('players.view', async () => {
  const { getActiveServer } =
    await import('../../../panel-server/database/init.ts')
  const { listWhitelistAccounts } =
    await import('../../../panel-server/utils/whitelistDb.ts')
  const activeServer = await getActiveServer()
  if (!activeServer)
    invalid('No active server selected', 'PLAYERS_NO_ACTIVE_SERVER')
  if (activeServer.isRemote) {
    return {
      success: true,
      available: false,
      accounts: [],
      allowedSteamIds: [],
      reason: 'Whitelist roster is not available for remote servers yet',
      server: { id: activeServer.id, name: activeServer.serverName },
    }
  }
  return {
    success: true,
    ...(await listWhitelistAccounts(
      activeServer.zomboidDataPath,
      activeServer.serverName,
    )),
    server: { id: activeServer.id, name: activeServer.serverName },
  }
})

async function logPlayerAction(
  player: string,
  action: string,
  details?: unknown | null,
): Promise<void> {
  const { logPlayerAction: writePlayerAction } =
    await import('../../../panel-server/database/init.ts')
  await writePlayerAction(player, action, details)
}

export const kickPlayer = createControlAction(
  'players.moderate',
  async (runtime, data) => {
    const username = requiredString(
      data,
      'username',
      'Username is required',
      'PLAYERS_USERNAME_REQUIRED',
    )
    if (!validUsername(username))
      invalid('Invalid username format', 'PLAYERS_INVALID_USERNAME')
    if (data.reason && !validText(data.reason))
      invalid('Invalid reason format', 'PLAYERS_INVALID_REASON')
    const result = await runtime.rconService.kickPlayer(username, data.reason)
    if (result?.success) await logPlayerAction(username, 'kick', data.reason)
    return result
  },
)

export const banPlayer = createControlAction(
  'players.moderate',
  async (runtime, data) => {
    const username = requiredString(
      data,
      'username',
      'Username is required',
      'PLAYERS_USERNAME_REQUIRED',
    )
    if (!validUsername(username))
      invalid('Invalid username format', 'PLAYERS_INVALID_USERNAME')
    if (data.banIp !== undefined && typeof data.banIp !== 'boolean')
      invalid('banIp must be a boolean', 'PLAYERS_INVALID_BAN_IP')
    if (data.reason && !validText(data.reason))
      invalid('Invalid reason format', 'PLAYERS_INVALID_REASON')
    const result = await runtime.rconService.banPlayer(
      username,
      data.banIp,
      data.reason,
    )
    const sentReason = result?.sentReason ?? data.reason
    if (result?.success)
      await logPlayerAction(
        username,
        'ban',
        `IP: ${data.banIp}, Reason: ${sentReason}`,
      )
    return result
  },
)

export const unbanPlayer = createControlAction(
  'players.moderate',
  async (runtime, data) => {
    const username = requiredString(
      data,
      'username',
      'Username is required',
      'PLAYERS_USERNAME_REQUIRED',
    )
    if (!validUsername(username))
      invalid('Invalid username format', 'PLAYERS_INVALID_USERNAME')
    const result = await runtime.rconService.unbanPlayer(username)
    if (result?.success) await logPlayerAction(username, 'unban', null)
    return result
  },
)

export const setAccessLevel = createControlAction(
  'players.moderate',
  async (runtime, data) => {
    const username = requiredString(
      data,
      'username',
      'Username and level are required',
      'PLAYERS_ACCESS_LEVEL_FIELDS_REQUIRED',
    )
    const level = requiredString(
      data,
      'level',
      'Username and level are required',
      'PLAYERS_ACCESS_LEVEL_FIELDS_REQUIRED',
    )
    if (!validUsername(username))
      invalid('Invalid username format', 'PLAYERS_INVALID_USERNAME')
    const { ACCESS_LEVELS } =
      await import('../../../panel-server/utils/commands.ts')
    const { getActiveServer } =
      await import('../../../panel-server/database/init.ts')
    const { listServerRoleNames } =
      await import('../../../panel-server/utils/whitelistDb.ts')
    const activeServer = await getActiveServer()
    let validLevels = ACCESS_LEVELS
    if (activeServer && !activeServer.isRemote) {
      const roleResult = await listServerRoleNames(
        activeServer.zomboidDataPath,
        activeServer.serverName,
      )
      if (roleResult.available) {
        validLevels = [...roleResult.roleNames, 'none']
      }
    }
    if (!validLevels.includes(level.toLowerCase())) {
      invalid(
        `Invalid access level. Valid: ${validLevels.join(', ')}`,
        'PLAYERS_INVALID_ACCESS_LEVEL',
        { validLevels: validLevels.join(', ') },
      )
    }
    const result = await runtime.rconService.setAccessLevel(username, level)
    if (result?.success) await logPlayerAction(username, 'access_level', level)
    return result
  },
)

export const addToWhitelist = createControlAction(
  'players.moderate',
  async (runtime, data) => {
    const username = requiredString(
      data,
      'username',
      'Username is required',
      'PLAYERS_USERNAME_REQUIRED',
    )
    if (!validUsername(username))
      invalid('Invalid username format', 'PLAYERS_INVALID_USERNAME')
    if (
      data.password !== undefined &&
      data.password !== '' &&
      (typeof data.password !== 'string' ||
        !/^[a-zA-Z0-9!@#$%^&*_-]{4,64}$/.test(data.password))
    ) {
      invalid('Invalid password format', 'PLAYERS_INVALID_PASSWORD')
    }
    const result = await runtime.rconService.addToWhitelist(
      username,
      data.password,
    )
    if (!result?.success)
      throwControlError(
        Object.assign(
          new Error(result?.error || 'Whitelist add failed'),
          result,
        ),
        400,
      )
    await logPlayerAction(username, 'whitelist_add', null)
    return result
  },
)

export const removeFromWhitelist = createControlAction(
  'players.moderate',
  async (runtime, data) => {
    const username = requiredString(
      data,
      'username',
      'Username is required',
      'PLAYERS_USERNAME_REQUIRED',
    )
    if (!validUsername(username))
      invalid('Invalid username format', 'PLAYERS_INVALID_USERNAME')
    const result = await runtime.rconService.removeFromWhitelist(username)
    if (!result?.success)
      throwControlError(
        Object.assign(
          new Error(result?.error || 'Whitelist removal failed'),
          result,
        ),
        400,
      )
    await logPlayerAction(username, 'whitelist_remove', null)
    return result
  },
)

export const addAllowedSteamId = createControlAction(
  'players.moderate',
  async (runtime, data) => {
    const steamId = requiredString(
      data,
      'steamId',
      'SteamID is required',
      'PLAYERS_STEAMID_REQUIRED',
    )
    if (!/^\d{17}$/.test(steamId))
      invalid(
        'Invalid SteamID format (must be 17 digits)',
        'PLAYERS_INVALID_STEAMID',
      )
    const result = await runtime.rconService.addAllowedSteamId(steamId)
    if (!result?.success)
      throwControlError(
        Object.assign(
          new Error(result?.error || 'Could not add SteamID'),
          result,
        ),
        400,
      )
    await logPlayerAction(steamId, 'whitelist_steamid_add', null)
    return result
  },
)

export const removeAllowedSteamId = createControlAction(
  'players.moderate',
  async (runtime, data) => {
    const steamId = requiredString(
      data,
      'steamId',
      'SteamID is required',
      'PLAYERS_STEAMID_REQUIRED',
    )
    if (!/^\d{17}$/.test(steamId))
      invalid(
        'Invalid SteamID format (must be 17 digits)',
        'PLAYERS_INVALID_STEAMID',
      )
    const result = await runtime.rconService.removeAllowedSteamId(steamId)
    if (!result?.success)
      throwControlError(
        Object.assign(
          new Error(result?.error || 'Could not remove SteamID'),
          result,
        ),
        400,
      )
    await logPlayerAction(steamId, 'whitelist_steamid_remove', null)
    return result
  },
)

export const teleportPlayer = createControlAction(
  'players.gm_tools',
  async (runtime, data) => {
    const player1 = data.player1
    const player2 = data.player2
    let { x, y, z } = data
    if (
      (x === undefined || y === undefined || z === undefined) &&
      typeof player2 === 'string' &&
      player2.includes(',')
    ) {
      const parts = player2.split(',').map((part: string) => part.trim())
      if (parts.length >= 2) {
        ;[x, y] = parts
        z = parts[2] ?? '0'
      }
    }
    if (x !== undefined && y !== undefined && z !== undefined) {
      if (
        !validNumber(x, 0, 24000) ||
        !validNumber(y, 0, 24000) ||
        !validNumber(z, 0, 8)
      )
        invalid(
          'Invalid coordinates (x/y: 0 to 24000, z: 0 to 8)',
          'PLAYERS_TELEPORT_INVALID_COORDINATES',
        )
      if (player1) {
        if (!validUsername(player1))
          invalid(
            'Invalid player1 username format',
            'PLAYERS_TELEPORT_INVALID_PLAYER1',
          )
        if (!runtime.panelBridge?.isRunning)
          throwControlError(
            Object.assign(
              new Error(
                'PanelBridge is not running — cannot teleport a player to coordinates without it',
              ),
              { status: 503, code: 'PLAYERS_TELEPORT_BRIDGE_OFFLINE' },
            ),
            503,
          )
        return runtime.panelBridge.teleportPlayer(
          player1,
          Number(x),
          Number(y),
          Number(z),
        )
      }
      return runtime.rconService.teleportTo(x, y, z)
    }
    if (!player1)
      invalid(
        'Player name or coordinates required',
        'PLAYERS_TELEPORT_TARGET_REQUIRED',
      )
    if (!validUsername(player1))
      invalid(
        'Invalid player1 username format',
        'PLAYERS_TELEPORT_INVALID_PLAYER1',
      )
    if (player2 && !validUsername(player2))
      invalid(
        'Invalid player2 username format',
        'PLAYERS_TELEPORT_INVALID_PLAYER2',
      )
    return runtime.rconService.teleportPlayer(player1, player2)
  },
)

export const addPlayerItem = createControlAction(
  'players.gm_tools',
  async (runtime, data) => {
    const username = requiredString(
      data,
      'username',
      'A player must be selected to give items',
      'PLAYERS_ADD_ITEM_TARGET_REQUIRED',
    )
    const item = requiredString(
      data,
      'item',
      'Item is required',
      'PLAYERS_ITEM_REQUIRED',
    )
    if (!/^[A-Za-z0-9_]+\.[A-Za-z0-9_&#+.\-]+$/.test(item))
      invalid('Invalid item format', 'PLAYERS_INVALID_ITEM')
    if (!validUsername(username))
      invalid('Invalid username format', 'PLAYERS_INVALID_USERNAME')
    if (data.count !== undefined && !validNumber(data.count, 1, 100))
      invalid('Invalid count (1-100)', 'PLAYERS_INVALID_ITEM_COUNT')
    const count =
      data.count === undefined
        ? 1
        : Math.min(Math.floor(Number(data.count)), 100)
    const result = await runtime.rconService.addItem(username, item, count)
    if (result?.success)
      await logPlayerAction(username, 'add_item', `${item} x${count}`)
    return result
  },
)

export const addPlayerXp = createControlAction(
  'players.gm_tools',
  async (runtime, data) => {
    const username = requiredString(
      data,
      'username',
      'Username, perk, and amount are required',
      'PLAYERS_ADD_XP_FIELDS_REQUIRED',
    )
    const perk = requiredString(
      data,
      'perk',
      'Username, perk, and amount are required',
      'PLAYERS_ADD_XP_FIELDS_REQUIRED',
    )
    if (data.amount === undefined || data.amount === null)
      invalid(
        'Username, perk, and amount are required',
        'PLAYERS_ADD_XP_FIELDS_REQUIRED',
      )
    if (!validUsername(username))
      invalid('Invalid username format', 'PLAYERS_INVALID_USERNAME')
    const { PERKS } = await import('../../../panel-server/utils/commands.ts')
    if (!PERKS.includes(perk))
      invalid(
        `Invalid perk. Valid: ${PERKS.join(', ')}`,
        'PLAYERS_INVALID_PERK',
        { validPerks: PERKS.join(', ') },
      )
    if (!validNumber(data.amount, 0, 100000))
      invalid('Invalid XP amount (0-100000)', 'PLAYERS_INVALID_XP_AMOUNT')
    const result = await runtime.rconService.addXp(username, perk, data.amount)
    if (result?.success)
      await logPlayerAction(username, 'add_xp', `${perk}=${data.amount}`)
    return result
  },
)

export const addPlayerVehicle = createControlAction(
  'players.gm_tools',
  async (runtime, data) => {
    const vehicle = requiredString(
      data,
      'vehicle',
      'Vehicle is required',
      'PLAYERS_VEHICLE_REQUIRED',
    )
    if (!/^[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/.test(vehicle))
      invalid('Invalid vehicle ID format', 'PLAYERS_INVALID_VEHICLE_ID')
    if (data.username && !validUsername(data.username))
      invalid('Invalid username format', 'PLAYERS_INVALID_USERNAME')
    const result = await runtime.rconService.addVehicle(vehicle, data.username)
    if (data.username && result?.success)
      await logPlayerAction(data.username, 'add_vehicle', vehicle)
    return result
  },
)

export const addPlayerVehicleAt = createControlAction(
  'players.gm_tools',
  async (runtime, data) => {
    const vehicle = requiredString(
      data,
      'vehicle',
      'Vehicle is required',
      'PLAYERS_VEHICLE_REQUIRED',
    )
    if (!/^[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/.test(vehicle))
      invalid('Invalid vehicle ID format', 'PLAYERS_INVALID_VEHICLE_ID')
    const z = data.z ?? 0
    if (
      !validNumber(data.x, 0, 24000) ||
      !validNumber(data.y, 0, 24000) ||
      !validNumber(z, 0, 8)
    )
      invalid('Invalid map coordinates', 'PLAYERS_INVALID_MAP_COORDINATES')
    return runtime.rconService.addVehicleAt(
      vehicle,
      Number(data.x),
      Number(data.y),
      Number(z),
    )
  },
)

async function setPlayerMode(
  runtime: AnyRecord,
  method: 'setGodMode' | 'setInvisible' | 'setNoclip',
  bridgeAction: string,
  username: string,
  enabled: boolean,
) {
  if (runtime.panelBridge?.isRunning) {
    const result = await runtime.panelBridge.sendCommand(bridgeAction, {
      username,
      enabled,
    })
    return { ...result, via: 'bridge' }
  }
  const result = await runtime.rconService[method](username, enabled)
  return {
    ...result,
    via: 'rcon',
    warning:
      'PanelBridge is offline; this was sent via RCON instead, which reports less detail about the result.',
  }
}

function playerModeAction(
  method: 'setGodMode' | 'setInvisible' | 'setNoclip',
  action: string,
) {
  return createControlAction('players.gm_tools', async (runtime, data) => {
    const username = requiredString(
      data,
      'username',
      'Username is required',
      'PLAYERS_USERNAME_REQUIRED',
    )
    if (!validUsername(username))
      invalid('Invalid username format', 'PLAYERS_INVALID_USERNAME')
    if (typeof data.enabled !== 'boolean')
      invalid('enabled must be a boolean', 'PLAYERS_INVALID_ENABLED_FLAG')
    const result = await setPlayerMode(
      runtime,
      method,
      action,
      username,
      data.enabled,
    )
    if (result?.success)
      await logPlayerAction(
        username,
        action.toLowerCase(),
        data.enabled ? 'enabled' : 'disabled',
      )
    return result
  })
}

export const setGodMode = playerModeAction('setGodMode', 'setGodMode')
export const setInvisible = playerModeAction('setInvisible', 'setInvisible')
export const setNoclip = playerModeAction('setNoclip', 'setNoclip')

export const getPlayerVehicles = createControlRead('players.view', async () => {
  const { VEHICLES } = await import('../../../panel-server/utils/commands.ts')
  return { vehicles: VEHICLES }
})

export const getPlayerPerks = createControlRead('players.view', async () => {
  const { PERKS, PERK_CATALOG } =
    await import('../../../panel-server/utils/commands.ts')
  return { perks: PERKS, catalog: PERK_CATALOG }
})

export const getPlayerAccessLevels = createControlRead(
  'players.view',
  async () => {
    const { ACCESS_LEVELS } =
      await import('../../../panel-server/utils/commands.ts')
    const { getActiveServer } =
      await import('../../../panel-server/database/init.ts')
    const { listServerRoleNames } =
      await import('../../../panel-server/utils/whitelistDb.ts')
    const activeServer = await getActiveServer()
    if (!activeServer || activeServer.isRemote)
      return { levels: ACCESS_LEVELS, available: false }
    const result = await listServerRoleNames(
      activeServer.zomboidDataPath,
      activeServer.serverName,
    )
    return {
      levels: result.available ? [...result.roleNames, 'none'] : ACCESS_LEVELS,
      available: result.available,
      ...(result.reason ? { reason: result.reason } : {}),
    }
  },
)

export const banSteamId = createControlAction(
  'players.moderate',
  async (runtime, data) => {
    const steamId = requiredString(
      data,
      'steamId',
      'SteamID is required',
      'PLAYERS_STEAMID_REQUIRED',
    )
    if (!/^\d{17}$/.test(steamId))
      invalid(
        'Invalid SteamID format (must be 17 digits)',
        'PLAYERS_INVALID_STEAMID',
      )
    const reason = typeof data.reason === 'string' ? data.reason.trim() : ''
    if (reason && !validText(reason))
      invalid('Invalid reason format', 'PLAYERS_INVALID_REASON')
    const result = await runtime.rconService.banSteamId(steamId)
    if (result?.success) {
      const { addSteamIdBan } =
        await import('../../../panel-server/database/init.ts')
      await addSteamIdBan(steamId, reason || null)
      await logPlayerAction(steamId, 'banid', reason || null)
    }
    return result
  },
)

export const unbanSteamId = createControlAction(
  'players.moderate',
  async (runtime, data) => {
    const steamId = requiredString(
      data,
      'steamId',
      'SteamID is required',
      'PLAYERS_STEAMID_REQUIRED',
    )
    if (!/^\d{17}$/.test(steamId))
      invalid(
        'Invalid SteamID format (must be 17 digits)',
        'PLAYERS_INVALID_STEAMID',
      )
    const result = await runtime.rconService.unbanSteamId(steamId)
    if (result?.success) {
      const { removeSteamIdBan } =
        await import('../../../panel-server/database/init.ts')
      await removeSteamIdBan(steamId)
      await logPlayerAction(steamId, 'unbanid', null)
    }
    return result
  },
)

export const getSteamIdBans = createControlRead('players.view', async () => {
  const { getSteamIdBans: readBans } =
    await import('../../../panel-server/database/init.ts')
  return { bans: await readBans() }
})

export const setVoiceBan = createControlAction(
  'players.moderate',
  async (runtime, data) => {
    const username = requiredString(
      data,
      'username',
      'Username is required',
      'PLAYERS_USERNAME_REQUIRED',
    )
    if (!validUsername(username))
      invalid('Invalid username format', 'PLAYERS_INVALID_USERNAME')
    if (typeof data.enabled !== 'boolean')
      invalid('enabled must be a boolean', 'PLAYERS_INVALID_ENABLED_FLAG')
    const result = await runtime.rconService.voiceBan(username, data.enabled)
    if (result?.success)
      await logPlayerAction(
        username,
        'voiceban',
        data.enabled ? 'enabled' : 'disabled',
      )
    return result
  },
)

export const addRconUser = createControlAction(
  'players.moderate',
  async (runtime, data) => {
    const username = requiredString(
      data,
      'username',
      'Username is required',
      'PLAYERS_USERNAME_REQUIRED',
    )
    if (!validUsername(username))
      invalid('Invalid username format', 'PLAYERS_INVALID_USERNAME')
    if (
      data.password !== undefined &&
      data.password !== '' &&
      (typeof data.password !== 'string' ||
        !/^[a-zA-Z0-9!@#$%^&*_-]{4,64}$/.test(data.password))
    )
      invalid('Invalid password format', 'PLAYERS_INVALID_PASSWORD')
    const result = await runtime.rconService.addUser(username, data.password)
    if (!result?.success)
      throwControlError(
        Object.assign(new Error(result?.error || 'Could not add user'), result),
        400,
      )
    await logPlayerAction(username, 'adduser', null)
    return result
  },
)

export const addAllToWhitelist = createControlAction(
  'players.moderate',
  (runtime) => runtime.rconService.addAllToWhitelist(),
)

export const getRconStatus = createControlRead(null, async () => {
  const runtime = await panelRuntime()
  return runtime.rconService.getConfig()
})

export const executeRcon = createControlAction(
  'rcon.execute',
  async (runtime, data) => {
    const command = data.command
    if (!command) invalid('Command is required', 'RCON_COMMAND_REQUIRED')
    if (typeof command !== 'string' || command.length > 2000) {
      invalid('Invalid command (max 2000 characters)', 'RCON_COMMAND_INVALID')
    }
    const result = await runtime.rconService.execute(command)
    const { redactRconCommandSecrets } =
      await import('../../../panel-server/utils/rconCommandRedaction.ts')
    runtime.io?.to?.('rcon-live')?.emit?.('rcon:response', {
      command: redactRconCommandSecrets(command),
      response: redactRconCommandSecrets(result.response || result.error),
      success: result.success,
      timestamp: new Date().toISOString(),
    })
    return result
  },
)

export const connectRcon = createControlAction(
  'rcon.execute',
  async (runtime, data, context) => {
    const host = data.host
    const port = data.port
    const password = data.password
    if (
      host !== undefined &&
      (typeof host !== 'string' ||
        host.length > 255 ||
        !/^[a-zA-Z0-9.-]+$/.test(host))
    ) {
      invalid('Invalid host format', 'RCON_INVALID_HOST')
    }
    let normalizedPort: number | undefined
    if (port !== undefined) {
      const { parseBoundedInteger } =
        await import('../../../panel-server/utils/queryNumbers.ts')
      const parsedPort = parseBoundedInteger(port, null, 1, 65535)
      if (parsedPort === null) {
        invalid('Invalid port (1-65535)', 'RCON_INVALID_PORT')
      }
      normalizedPort = parsedPort
    }
    if (
      password !== undefined &&
      (typeof password !== 'string' || password.length > 256)
    ) {
      invalid('Invalid password format', 'RCON_INVALID_PASSWORD')
    }
    if (host !== undefined || port !== undefined || password !== undefined) {
      await assertCapability(context, 'servers.manage')
      await runtime.rconService.updateConfig(host, normalizedPort, password)
    }
    let connected = false
    try {
      connected = await runtime.rconService.connect()
    } catch {
      connected = false
    }
    if (connected) return { success: true, message: 'Connected to RCON' }

    const { checkTcpReachable, RCON_USER_ACTION_TIMEOUT_MS } =
      await import('../../../panel-server/services/rcon.ts')
    const config = runtime.rconService.getConfig()
    const reachable = await checkTcpReachable(
      config.host,
      config.port,
      RCON_USER_ACTION_TIMEOUT_MS,
    )
    throwControlError(
      Object.assign(
        new Error(
          reachable
            ? 'RCON authentication failed'
            : 'Cannot connect to server. Is the game server running with RCON enabled?',
        ),
        {
          status: 503,
          code: reachable
            ? 'RCON_CONNECT_AUTH_FAILED'
            : 'RCON_CONNECT_UNREACHABLE',
        },
      ),
      503,
    )
  },
)

export const disconnectRcon = createControlAction('rcon.execute', (runtime) =>
  runtime.rconService.disconnect().then(() => ({
    success: true,
    message: 'Disconnected from RCON',
  })),
)

export const getRconHistory = createControlRead(
  'rcon.execute',
  async (data) => {
    const [{ getCommandHistory }, { parseClampedInteger }] = await Promise.all([
      import('../../../panel-server/database/init.ts'),
      import('../../../panel-server/utils/queryNumbers.ts'),
    ])
    const limit = parseClampedInteger(data.limit, 100, 1, 1000)
    return { history: await getCommandHistory(limit) }
  },
)

export const getRconCommands = createControlRead(null, async (data) => {
  const { PZ_COMMANDS } =
    await import('../../../panel-server/utils/commands.ts')
  const category = typeof data.category === 'string' ? data.category : ''
  if (!category) return { commands: PZ_COMMANDS }

  const commands = Object.fromEntries(
    Object.entries(PZ_COMMANDS).filter(
      ([, command]) => command.category === category,
    ),
  )
  return { commands }
})

export const getRconHealth = createControlRead(null, async () => {
  try {
    const health = await (await panelRuntime()).rconService.healthCheck()
    if (!health.healthy) setResponseStatus(503)
    return { success: health.healthy, ...health }
  } catch (error) {
    throwControlError(
      Object.assign(new Error(errorMessage(error)), {
        success: false,
        reason: errorMessage(error),
      }),
      500,
    )
  }
})

export const testRconConnection = createControlAction(
  ['rcon.execute', 'servers.manage'],
  async (_runtime, data) => {
    const host = data.host
    const { parseBoundedInteger } =
      await import('../../../panel-server/utils/queryNumbers.ts')
    const port = parseBoundedInteger(data.port, null, 1, 65535)
    const password = data.password
    const validationError =
      typeof host !== 'string' ||
      host.length > 255 ||
      !/^[a-zA-Z0-9.-]+$/.test(host)
        ? 'Invalid host format'
        : port === null
          ? 'Invalid port (1-65535)'
          : password !== undefined &&
              (typeof password !== 'string' || password.length > 256)
            ? 'Invalid password format'
            : null
    if (validationError) {
      return {
        success: false,
        error: 'invalid_input',
        detail: validationError,
      }
    }
    try {
      const { testRconConnection: test } =
        await import('../../../panel-server/services/rcon.ts')
      return (await test({ host, port, password })) as {
        success: boolean
        error?:
          'unreachable' | 'auth_failed' | 'invalid_input' | 'internal_error'
        detail: string
      }
    } catch (error) {
      return {
        success: false,
        error: 'internal_error',
        detail: errorMessage(error),
      }
    }
  },
)

function taskId(value: unknown): number | null {
  const number =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^[+-]?\d+$/.test(value.trim())
        ? Number(value.trim())
        : Number.NaN
  return Number.isSafeInteger(number) && number > 0 ? number : null
}

type CronCheck = { valid: true } | { valid: false; error: string; code: string }

async function checkCronExpression(expression: string): Promise<CronCheck> {
  const {
    hasUnsupportedCronFieldCount,
    isCronTooFrequent,
    isSupportedFiveFieldCron,
  } = await import('../../../panel-server/utils/cronValidation.ts')
  if (!isSupportedFiveFieldCron(expression))
    return {
      valid: false,
      error: 'Invalid cron expression format',
      code: 'SCHEDULER_INVALID_CRON_EXPRESSION',
    }
  if (hasUnsupportedCronFieldCount(expression))
    return {
      valid: false,
      error:
        'The panel does not support seconds-precision schedules. Use exactly 5 fields: minute hour day month weekday.',
      code: 'SCHEDULER_CRON_SECONDS_UNSUPPORTED',
    }
  if (isCronTooFrequent(expression))
    return {
      valid: false,
      error: 'Tasks cannot run more frequently than every 5 minutes',
      code: 'SCHEDULER_CRON_TOO_FREQUENT',
    }
  return { valid: true }
}

function assertCronCheck(check: CronCheck): asserts check is { valid: true } {
  if (!check.valid) invalid(check.error, check.code)
}

function emitSchedulerAction(runtime: AnyRecord, payload: AnyRecord): void {
  if (typeof runtime.io?.emit === 'function')
    runtime.io.emit('scheduler:action_result', payload)
}

export const getSchedulerStatus = createControlRead(
  'automation.manage',
  async () => (await panelRuntime()).scheduler.getStatus() as SchedulerStatus,
)

export const getSchedulerTasks = createControlRead(
  'automation.manage',
  async () => {
    const { getScheduledTasks } =
      await import('../../../panel-server/database/init.ts')
    return { tasks: await getScheduledTasks() }
  },
)

export const validateSchedulerCron = createControlAction(
  'automation.manage',
  async (_runtime, data) => {
    const expression = data.cronExpression
    if (typeof expression !== 'string' || !expression) {
      throwControlError(
        Object.assign(new Error('cronExpression is required'), {
          code: 'SCHEDULER_CRON_EXPRESSION_REQUIRED',
          valid: false,
        }),
        400,
      )
    }
    return checkCronExpression(expression)
  },
)

export const createScheduledTaskAction = createControlAction(
  'automation.manage',
  async (runtime, data, context) => {
    if (!data.name || !data.cronExpression || !data.command)
      invalid(
        'Name, cronExpression, and command are required',
        'SCHEDULER_TASK_FIELDS_REQUIRED',
      )
    if (typeof data.name !== 'string' || data.name.length > 100)
      invalid(
        'Invalid task name (max 100 chars)',
        'SCHEDULER_INVALID_TASK_NAME',
      )
    if (typeof data.command !== 'string' || data.command.length > 2000)
      invalid('Invalid command (max 2000 chars)', 'SCHEDULER_INVALID_COMMAND')
    if (
      typeof data.cronExpression !== 'string' ||
      data.cronExpression.length > 100
    )
      invalid('Invalid cron expression format', 'SCHEDULER_INVALID_CRON_FORMAT')

    const { requiredCapabilityForScheduledCommand } =
      await import('../../../panel-server/utils/schedulerPermissions.ts')
    await assertCapability(
      context,
      requiredCapabilityForScheduledCommand(data.command),
    )
    assertCronCheck(await checkCronExpression(data.cronExpression))

    const {
      createScheduledTask,
      deleteScheduledTask,
      getActiveServer,
      getServer,
    } = await import('../../../panel-server/database/init.ts')
    let serverId = data.serverId ?? null
    if (serverId) {
      if (!(await getServer(serverId)))
        invalid('Target server not found', 'SCHEDULER_TARGET_SERVER_NOT_FOUND')
    } else {
      const active = await getActiveServer()
      serverId = active ? active.id : null
    }

    const result = await createScheduledTask(
      data.name,
      data.cronExpression,
      data.command,
      serverId,
    )
    const task = {
      id: result.id,
      name: data.name,
      cron_expression: data.cronExpression,
      command: data.command,
      server_id: serverId,
      enabled: 1,
    }

    try {
      const scheduleResult = runtime.scheduler.scheduleTask(task)
      if (scheduleResult === false)
        throw new Error('Scheduler rejected the task')
      return {
        success: true,
        task,
        dstWarning: scheduleResult?.dstWarning || null,
      }
    } catch (error) {
      await deleteScheduledTask(result.id)
      throwControlError(
        Object.assign(
          new Error(`Failed to schedule task: ${errorMessage(error)}`),
          {
            code: 'SCHEDULER_TASK_SCHEDULING_FAILED',
            params: { reason: errorMessage(error) },
          },
        ),
      )
    }
  },
)

export const updateScheduledTaskAction = createControlAction(
  'automation.manage',
  async (runtime, data, context) => {
    const id = taskId(data.id)
    if (id === null) invalid('Invalid task ID', 'SCHEDULER_INVALID_TASK_ID')
    if (
      data.name !== undefined &&
      (typeof data.name !== 'string' || data.name.length > 100)
    )
      invalid(
        'Invalid task name (max 100 characters)',
        'SCHEDULER_INVALID_TASK_NAME',
      )
    if (
      data.command !== undefined &&
      (typeof data.command !== 'string' || data.command.length > 2000)
    )
      invalid(
        'Invalid command (max 2000 characters)',
        'SCHEDULER_INVALID_COMMAND',
      )
    if (data.command !== undefined) {
      const { requiredCapabilityForScheduledCommand } =
        await import('../../../panel-server/utils/schedulerPermissions.ts')
      await assertCapability(
        context,
        requiredCapabilityForScheduledCommand(data.command),
      )
    }
    if (
      data.enabled !== undefined &&
      ![true, false, 0, 1].includes(data.enabled)
    )
      invalid(
        'enabled must be a boolean or 0/1',
        'SCHEDULER_INVALID_ENABLED_VALUE',
      )
    const enabled =
      data.enabled === undefined
        ? undefined
        : data.enabled === true || data.enabled === 1
    if (data.cronExpression) {
      if (typeof data.cronExpression !== 'string')
        invalid(
          'Invalid cron expression format',
          'SCHEDULER_INVALID_CRON_FORMAT',
        )
      assertCronCheck(await checkCronExpression(data.cronExpression))
    }

    const { getScheduledTasks, getServer, updateScheduledTask } =
      await import('../../../panel-server/database/init.ts')
    if (data.serverId !== undefined && data.serverId !== null) {
      if (!(await getServer(data.serverId)))
        invalid('Target server not found', 'SCHEDULER_TARGET_SERVER_NOT_FOUND')
    }
    const tasksBeforeUpdate = await getScheduledTasks()
    const previousTaskRecord = Array.isArray(tasksBeforeUpdate)
      ? tasksBeforeUpdate.find(
          (task: AnyRecord) => String(task.id) === String(id),
        )
      : null
    const previousTask = previousTaskRecord ? { ...previousTaskRecord } : null
    const updated = await updateScheduledTask(
      id,
      data.name,
      data.cronExpression,
      data.command,
      enabled,
      data.serverId,
    )
    if (!updated)
      throwControlError(
        Object.assign(new Error('Task not found'), {
          status: 404,
          code: 'SCHEDULER_TASK_NOT_FOUND',
        }),
        404,
      )

    let dstWarning: string | null = null
    if (updated.enabled) {
      try {
        const scheduleResult = runtime.scheduler.scheduleTask({
          id,
          name: updated.name,
          cron_expression: updated.cron_expression,
          command: updated.command,
          server_id: updated.server_id,
          enabled: 1,
        })
        if (scheduleResult === false)
          throw new Error('Scheduler rejected the updated task')
        dstWarning = scheduleResult?.dstWarning || null
      } catch (error) {
        if (previousTask) {
          try {
            await updateScheduledTask(
              id,
              previousTask.name,
              previousTask.cron_expression,
              previousTask.command,
              previousTask.enabled,
              previousTask.server_id,
            )
            if (previousTask.enabled)
              runtime.scheduler.scheduleTask(previousTask)
            else runtime.scheduler.cancelTask(id)
          } catch (rollbackError) {
            void rollbackError
          }
        }
        throwControlError(
          Object.assign(
            new Error(`Failed to reschedule task: ${errorMessage(error)}`),
            {
              code: 'SCHEDULER_TASK_RESCHEDULE_FAILED',
              params: { reason: errorMessage(error) },
            },
          ),
        )
      }
    } else {
      runtime.scheduler.cancelTask(id)
    }
    return { success: true, message: 'Task updated', dstWarning }
  },
)

export const runScheduledTask = createControlAction(
  'automation.manage',
  async (runtime, data, context) => {
    const id = taskId(data.id)
    if (id === null) invalid('Invalid task ID', 'SCHEDULER_INVALID_TASK_ID')
    const { getScheduledTasks } =
      await import('../../../panel-server/database/init.ts')
    const tasks = (await getScheduledTasks()) as AnyRecord[]
    const task = tasks.find((candidate) => candidate.id === id)
    if (!task)
      throwControlError(
        Object.assign(new Error('Task not found'), {
          status: 404,
          code: 'SCHEDULER_TASK_NOT_FOUND',
        }),
        404,
      )

    const { requiredCapabilityForScheduledCommand } =
      await import('../../../panel-server/utils/schedulerPermissions.ts')
    await assertCapability(
      context,
      requiredCapabilityForScheduledCommand(task.command),
    )
    void runtime.scheduler
      .runTaskNow(task)
      .then((result: AnyRecord) =>
        emitSchedulerAction(runtime, {
          kind: 'task',
          taskName: task.name,
          success: !!result?.success,
          message:
            result?.message ||
            (result?.success ? 'Task completed' : 'Task failed'),
        }),
      )
      .catch((error: unknown) =>
        emitSchedulerAction(runtime, {
          kind: 'task',
          taskName: task.name,
          success: false,
          message: errorMessage(error),
        }),
      )
    return { success: true, message: 'Task triggered' }
  },
)

export const deleteScheduledTask = createControlAction(
  'automation.manage',
  async (runtime, data) => {
    const id = taskId(data.id)
    if (id === null) invalid('Invalid task ID', 'SCHEDULER_INVALID_TASK_ID')
    const { deleteScheduledTask: deleteTask } =
      await import('../../../panel-server/database/init.ts')
    if (!(await deleteTask(id)))
      throwControlError(
        Object.assign(new Error('Task not found'), {
          status: 404,
          code: 'SCHEDULER_TASK_NOT_FOUND',
        }),
        404,
      )
    runtime.scheduler.cancelTask(id)
    return { success: true, message: 'Task deleted' }
  },
)

export const restartScheduledServer = createControlAction(
  'automation.manage',
  async (runtime, data, context) => {
    await assertCapability(context, 'server.control')
    const { getActiveServer } =
      await import('../../../panel-server/database/init.ts')
    const activeServer = await getActiveServer()
    if (activeServer?.isRemote)
      throwControlError(
        Object.assign(
          new Error(
            'Cannot restart a remote server. The process is not managed by this panel.',
          ),
          { status: 400, code: 'SCHEDULER_RESTART_REMOTE_NOT_SUPPORTED' },
        ),
        400,
      )
    const { parseBoundedInteger } =
      await import('../../../panel-server/utils/queryNumbers.ts')
    const warningMinutes = Math.min(
      parseBoundedInteger(data.warningMinutes, 5, 0, Number.MAX_SAFE_INTEGER),
      60,
    )
    void runtime.scheduler
      .performRestart(warningMinutes, { label: 'Manual restart' })
      .then((result: AnyRecord) =>
        emitSchedulerAction(runtime, {
          kind: 'restart',
          success: !!result?.success,
          message:
            result?.message ||
            (result?.success ? 'Restart completed' : 'Restart failed'),
        }),
      )
      .catch((error: unknown) =>
        emitSchedulerAction(runtime, {
          kind: 'restart',
          success: false,
          message: errorMessage(error),
        }),
      )
    return { success: true, message: 'Restart initiated', warningMinutes }
  },
)

export const getSchedulerHistory = createControlRead(
  'automation.manage',
  async (data) => {
    const [{ getScheduleHistory }, { parseClampedInteger }] = await Promise.all(
      [
        import('../../../panel-server/database/init.ts'),
        import('../../../panel-server/utils/queryNumbers.ts'),
      ],
    )
    const limit = parseClampedInteger(data.limit, 100, 1, 500)
    const taskIdValue = data.taskId === undefined ? null : taskId(data.taskId)
    if (data.taskId !== undefined && taskIdValue === null)
      invalid('Invalid task ID', 'SCHEDULER_INVALID_TASK_ID')
    return {
      history: (await getScheduleHistory(
        limit,
        taskIdValue,
      )) as ScheduleHistoryEntry[],
    }
  },
)

export const clearSchedulerHistory = createControlAction(
  'automation.manage',
  async () => {
    const { clearScheduleHistory } =
      await import('../../../panel-server/database/init.ts')
    await clearScheduleHistory()
    return { success: true, message: 'History cleared' }
  },
)

export const setSchedulerTimezone = createControlAction(
  'automation.manage',
  async (runtime, data) => {
    const timezone = requiredString(
      data,
      'timezone',
      'A timezone is required',
      'SCHEDULER_TIMEZONE_REQUIRED',
    )
    const { isValidIanaTimezone } =
      await import('../../../panel-server/utils/cronValidation.ts')
    if (!isValidIanaTimezone(timezone))
      invalid(
        `"${timezone}" is not a valid timezone name (e.g. "America/New_York", "UTC")`,
        'SCHEDULER_INVALID_TIMEZONE',
        { tz: timezone },
      )
    return { success: true, ...(await runtime.scheduler.setTimezone(timezone)) }
  },
)

export const setSchedulerRestartWarning = createControlAction(
  'automation.manage',
  async (runtime, data) => {
    try {
      return {
        success: true,
        restartWarning: await runtime.scheduler.setRestartWarning(data),
      }
    } catch (error) {
      throwControlError(error, 400)
    }
  },
)

export const getSchedulerPresets = createControlRead(
  'automation.manage',
  async () => ({
    presets: [
      { name: 'Every hour', cron: '0 * * * *' },
      { name: 'Every 2 hours', cron: '0 */2 * * *' },
      { name: 'Every 4 hours', cron: '0 */4 * * *' },
      { name: 'Every 6 hours', cron: '0 */6 * * *' },
      { name: 'Every 12 hours', cron: '0 */12 * * *' },
      { name: 'Daily at midnight', cron: '0 0 * * *' },
      { name: 'Daily at 6 AM', cron: '0 6 * * *' },
      { name: 'Daily at noon', cron: '0 12 * * *' },
      { name: 'Daily at 6 PM', cron: '0 18 * * *' },
      { name: 'Every 30 minutes', cron: '*/30 * * * *' },
      { name: 'Every 15 minutes', cron: '*/15 * * * *' },
    ],
  }),
)
