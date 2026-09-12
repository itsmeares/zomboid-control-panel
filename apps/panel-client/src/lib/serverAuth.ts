import { createServerFn } from '@tanstack/react-start'
import * as serverImplementation from './serverAuth.server'
import {
  invokeServerFunction,
  type ServerFunctionOptions,
} from './serverFunctionRpc'

export type AuthStatus = {
  needsSetup: boolean
  authEnabled: boolean
}

export type OidcStatus = {
  configured: boolean
  providerName: string
}

export type RecoveryStatus = {
  recoveryCodesAvailable: boolean
}

export type CurrentUser = {
  user: {
    id: string
    username: string
    role: string
    capabilities: string[] | null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseAuthStatus(value: unknown): AuthStatus {
  if (
    !isRecord(value) ||
    typeof value.needsSetup !== 'boolean' ||
    typeof value.authEnabled !== 'boolean'
  ) {
    throw new Error('Auth status response was invalid')
  }
  return {
    needsSetup: value.needsSetup,
    authEnabled: value.authEnabled,
  }
}

function parseOidcStatus(value: unknown): OidcStatus {
  if (
    !isRecord(value) ||
    typeof value.configured !== 'boolean' ||
    typeof value.providerName !== 'string'
  ) {
    throw new Error('OIDC status response was invalid')
  }
  return {
    configured: value.configured,
    providerName: value.providerName,
  }
}

function parseRecoveryStatus(value: unknown): RecoveryStatus {
  if (!isRecord(value) || typeof value.recoveryCodesAvailable !== 'boolean') {
    throw new Error('Recovery status response was invalid')
  }
  return { recoveryCodesAvailable: value.recoveryCodesAvailable }
}

function invoke<T>(
  serverFunction: unknown,
  name: string,
  options: ServerFunctionOptions,
): Promise<T> {
  return invokeServerFunction<T>(serverFunction, name, options)
}

export const getAuthStatus = createServerFn({
  method: 'GET',
  strict: { output: false },
}).handler(({ data, context }) =>
  invoke<AuthStatus>(serverImplementation.getAuthStatus, 'getAuthStatus', {
    data,
    context,
  }),
)

export const getOidcStatus = createServerFn({
  method: 'GET',
  strict: { output: false },
}).handler(({ data, context }) =>
  invoke<OidcStatus>(serverImplementation.getOidcStatus, 'getOidcStatus', {
    data,
    context,
  }),
)

export const getRecoveryStatus = createServerFn({
  method: 'GET',
  strict: { output: false },
}).handler(({ data, context }) =>
  invoke<RecoveryStatus>(
    serverImplementation.getRecoveryStatus,
    'getRecoveryStatus',
    { data, context },
  ),
)

export const getCurrentUser = createServerFn({
  method: 'GET',
  strict: { output: false },
}).handler(({ data, context }) =>
  invoke<CurrentUser>(serverImplementation.getCurrentUser, 'getCurrentUser', {
    data,
    context,
  }),
)

export async function getAuthStatusWithFallback(): Promise<AuthStatus> {
  try {
    return parseAuthStatus(await getAuthStatus())
  } catch {
    const response = await fetch('/api/auth/status')
    if (!response.ok) throw new Error(`Auth status returned ${response.status}`)
    return parseAuthStatus(await response.json())
  }
}

export async function getOidcStatusWithFallback(
  signal?: AbortSignal,
): Promise<OidcStatus> {
  try {
    return parseOidcStatus(await getOidcStatus())
  } catch {
    const response = await fetch(
      '/api/auth/oidc/status',
      signal ? { signal } : undefined,
    )
    if (!response.ok) throw new Error(`OIDC status returned ${response.status}`)
    return parseOidcStatus(await response.json())
  }
}

export async function getRecoveryStatusWithFallback(
  signal?: AbortSignal,
): Promise<RecoveryStatus> {
  try {
    return parseRecoveryStatus(await getRecoveryStatus())
  } catch {
    const response = await fetch(
      '/api/auth/recovery-status',
      signal ? { signal } : undefined,
    )
    if (!response.ok)
      throw new Error(`Recovery status returned ${response.status}`)
    return parseRecoveryStatus(await response.json())
  }
}
