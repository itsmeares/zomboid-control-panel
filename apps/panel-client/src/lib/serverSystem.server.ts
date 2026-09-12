import { createServerFn } from '@tanstack/react-start'
import type { DiskSpaceReport, RuntimeInfo, StorageHealth } from './api'
import { protectedServerFunctionMiddleware } from './serverAuth.server'

async function getRuntimeInfoImplementation(): Promise<RuntimeInfo> {
  const { buildRuntimeInfo } =
    await import('../../../panel-server/utils/runtimeInfo.ts')
  return buildRuntimeInfo() as RuntimeInfo
}

export const getRuntimeInfo = createServerFn({ method: 'GET' })
  .middleware(protectedServerFunctionMiddleware)
  .handler(getRuntimeInfoImplementation)
;(getRuntimeInfo as any).__executeImplementation = getRuntimeInfoImplementation

async function getDiskSpaceReport(): Promise<DiskSpaceReport> {
  const { getPanelRuntime } =
    await import('../../../panel-server/utils/panelRuntime.ts')
  const { buildDiskSpace } =
    await import('../../../panel-server/utils/systemInfo.ts')
  return buildDiskSpace(getPanelRuntime().diskMonitor)
}

export const getDiskSpace = createServerFn({ method: 'GET' })
  .middleware(protectedServerFunctionMiddleware)
  .handler(getDiskSpaceReport)
;(getDiskSpace as any).__executeImplementation = getDiskSpaceReport

async function getStorageHealthImplementation(): Promise<StorageHealth> {
  const { getCircuitBreakerStatus } =
    await import('../../../panel-server/database/init.ts')
  const { sanitizeError } =
    await import('../../../panel-server/utils/sanitize.ts')
  const circuitBreaker = getCircuitBreakerStatus()
  return {
    diskSpace: await getDiskSpaceReport(),
    circuitBreaker: {
      ...circuitBreaker,
      lastError: circuitBreaker.lastError
        ? sanitizeError(circuitBreaker.lastError)
        : null,
    },
  }
}

export const getStorageHealth = createServerFn({ method: 'GET' })
  .middleware(protectedServerFunctionMiddleware)
  .handler(getStorageHealthImplementation)
;(getStorageHealth as any).__executeImplementation = getStorageHealthImplementation
