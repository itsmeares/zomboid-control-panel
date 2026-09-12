import {
  createMiddleware,
  createServerFn,
  createServerOnlyFn,
} from '@tanstack/react-start'
import {
  deleteCookie,
  getCookie,
  getRequest,
  setCookie,
  setResponseHeader,
  setResponseStatus,
} from '@tanstack/react-start/server'
import { authClientMiddleware } from './authToken'

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

export type AuthContextUser = {
  userId: string | null
  username: string | null
  role: string
  tokenGen: number | null
  authDisabled?: boolean
}

type AnyRecord = Record<string, unknown>

function record(data: unknown): AnyRecord {
  return data && typeof data === 'object' && !Array.isArray(data)
    ? (data as AnyRecord)
    : {}
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function throwAuthError(message: string, status: number, code?: string): never {
  throw Object.assign(new Error(message), { status, ...(code ? { code } : {}) })
}

async function getAuthService() {
  try {
    const { getPanelRuntime } =
      await import('../../../panel-server/utils/panelRuntime.ts')
    const shared = getPanelRuntime().authService
    if (shared) return shared
  } catch {
    // Isolated server-function tests do not boot the panel runtime.
  }
  return (await import('../../../panel-server/services/auth.ts')).default
}

function assertStrictKeys(data: AnyRecord, keys: string[]): void {
  if (Object.keys(data).some((key) => !keys.includes(key))) {
    throwAuthError('Request fields are invalid', 400, 'AUTH_REQUEST_INVALID')
  }
}

function loginData(data: unknown): {
  username: string
  password: string
  rememberMe: boolean
} {
  const body = record(data)
  assertStrictKeys(body, ['username', 'password', 'rememberMe'])
  if (
    typeof body.username !== 'string' ||
    body.username.length < 1 ||
    body.username.length > 32 ||
    typeof body.password !== 'string' ||
    body.password.length < 1 ||
    body.password.length > 128 ||
    (body.rememberMe !== undefined && typeof body.rememberMe !== 'boolean')
  ) {
    throwAuthError('Login fields are invalid', 400, 'AUTH_REQUEST_INVALID')
  }
  return {
    username: body.username,
    password: body.password,
    rememberMe: body.rememberMe === true,
  }
}

function setupData(data: unknown): {
  username: string
  password: string
  rememberMe: boolean
  setupToken: string
  panelPort: number
} {
  const body = record(data)
  const rawPort = body.panelPort === undefined ? 3001 : body.panelPort
  const panelPort = typeof rawPort === 'number' ? rawPort : Number(rawPort)
  if (
    !Number.isInteger(panelPort) ||
    panelPort < 1024 ||
    panelPort > 65535
  ) {
    throwAuthError(
      'Panel port must be a whole number between 1024 and 65535',
      400,
      'SETUP_PANEL_PORT_INVALID',
    )
  }

  assertStrictKeys(body, [
    'username',
    'password',
    'rememberMe',
    'setupToken',
    'panelPort',
  ])
  const login = loginData({
    username: body.username,
    password: body.password,
    ...(body.rememberMe !== undefined ? { rememberMe: body.rememberMe } : {}),
  })
  if (typeof body.setupToken !== 'string' || body.setupToken.length < 1) {
    throwAuthError('Setup fields are invalid', 400, 'AUTH_REQUEST_INVALID')
  }
  return { ...login, setupToken: body.setupToken, panelPort }
}

type RateLimitBucket = { count: number; resetAt: number }
const authRateLimits = new Map<string, RateLimitBucket>()

const enforceAuthRateLimit = createServerOnlyFn(
  (
    scope: string,
    max: number,
    windowMs: number,
    message: string,
    code: string,
  ): void => {
    const request = getRequest()
    const clientKey = request.headers.get('x-panel-client-ip') || 'unknown'
    const key = `${scope}:${clientKey}`
    const now = Date.now()
    let bucket = authRateLimits.get(key)
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs }
      authRateLimits.set(key, bucket)
    }

    bucket.count += 1
    const resetSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))
    setResponseHeader(
      'RateLimit-Policy',
      `${max};w=${Math.floor(windowMs / 1000)}`,
    )
    setResponseHeader('RateLimit-Limit', String(max))
    setResponseHeader(
      'RateLimit-Remaining',
      String(Math.max(0, max - bucket.count)),
    )
    setResponseHeader('RateLimit-Reset', String(resetSeconds))
    if (bucket.count > max) {
      setResponseHeader('Retry-After', String(resetSeconds))
      throwAuthError(message, 429, code)
    }
  },
)

const refreshCookieOptions = createServerOnlyFn(
  async (includeMaxAge = true) => {
    const { getRefreshCookieOptions } =
      await import('../../../panel-server/utils/refreshCookie.ts')
    const request = getRequest()
    const options = getRefreshCookieOptions(
      {
        secure: request.url.startsWith('https:'),
        headers: {
          'x-forwarded-proto':
            request.headers.get('x-forwarded-proto') ?? undefined,
        },
      },
      includeMaxAge,
    )
    if (options.maxAge === undefined) return options
    // HTTP adapters receive milliseconds; cookie-es (used by Start) expects seconds.
    return { ...options, maxAge: Math.floor(options.maxAge / 1000) }
  },
)

const clearRefreshCookieForRequest = createServerOnlyFn(
  async (): Promise<void> => {
    deleteCookie('refreshToken', await refreshCookieOptions(false))
  },
)

const setRefreshCookie = createServerOnlyFn(
  async (refreshToken: string | null): Promise<void> => {
    if (!refreshToken) {
      await clearRefreshCookieForRequest()
      return
    }
    setCookie('refreshToken', refreshToken, await refreshCookieOptions())
  },
)

const authRequestMiddleware = createMiddleware({ type: 'request' }).server(
  async ({ request, next }) => {
    const authService = await getAuthService()
    const result = await authService.authenticateApiRequest(
      request.headers.get('authorization'),
    )

    if (!result.ok) {
      return Response.json(
        { error: result.error, code: result.code },
        { status: result.status },
      )
    }

    const authenticatedContext = { authenticatedUser: result.user }
    const nextContext = {
      context: authenticatedContext,
      // The split server-function adapter receives sendContext from
      // __executeServer when it invokes the server-only implementation.
      sendContext: authenticatedContext,
    }
    return next(nextContext)
  },
)

export function permissionMiddleware(capability: string) {
  return createMiddleware({ type: 'request' }).server(
    async ({ context, next }) => {
      const user = (
        context as unknown as { authenticatedUser?: AuthContextUser }
      ).authenticatedUser
      if (!user) {
        return Response.json(
          { error: 'Authentication required', code: 'AUTH_REQUIRED' },
          { status: 401 },
        )
      }

      const { getCapabilitiesForRole } =
        await import('../../../panel-server/services/permissions.ts')
      const capabilities = await getCapabilitiesForRole(user.role)
      if (!capabilities?.includes(capability)) {
        return Response.json(
          { error: 'Insufficient permissions', code: 'PERMISSION_DENIED' },
          { status: 403 },
        )
      }

      return next()
    },
  )
}

export function anyPermissionMiddleware(...capabilities: string[]) {
  return createMiddleware({ type: 'request' }).server(
    async ({ context, next }) => {
      const user = (
        context as unknown as { authenticatedUser?: AuthContextUser }
      ).authenticatedUser
      if (!user) {
        return Response.json(
          { error: 'Authentication required', code: 'AUTH_REQUIRED' },
          { status: 401 },
        )
      }

      const { getCapabilitiesForRole } =
        await import('../../../panel-server/services/permissions.ts')
      const roleCapabilities = await getCapabilitiesForRole(user.role)
      if (
        !roleCapabilities?.some((capability) =>
          capabilities.includes(capability),
        )
      ) {
        return Response.json(
          { error: 'Insufficient permissions', code: 'PERMISSION_DENIED' },
          { status: 403 },
        )
      }

      return next()
    },
  )
}

function roleMiddleware(role: string) {
  return createMiddleware({ type: 'request' }).server(
    async ({ context, next }) => {
      const user = (
        context as unknown as { authenticatedUser?: AuthContextUser }
      ).authenticatedUser
      if (!user) {
        return Response.json(
          { error: 'Authentication required', code: 'AUTH_REQUIRED' },
          { status: 401 },
        )
      }
      if (user.role !== role) {
        return Response.json(
          { error: 'Insufficient permissions', code: 'PERMISSION_DENIED' },
          { status: 403 },
        )
      }

      return next()
    },
  )
}

export const protectedServerFunctionMiddleware = [
  authClientMiddleware,
  authRequestMiddleware,
] as const

export const rolesReadMiddleware = [
  authClientMiddleware,
  authRequestMiddleware,
  permissionMiddleware('roles.manage'),
] as const

export const usersManageMiddleware = [
  authClientMiddleware,
  authRequestMiddleware,
  permissionMiddleware('users.manage'),
] as const

export const rolesManageMiddleware = [
  authClientMiddleware,
  authRequestMiddleware,
  permissionMiddleware('roles.manage'),
] as const

export const panelSettingsMiddleware = [
  authClientMiddleware,
  authRequestMiddleware,
  permissionMiddleware('panel.settings'),
] as const

export const diagnosticsMiddleware = [
  authClientMiddleware,
  authRequestMiddleware,
  permissionMiddleware('diagnostics.manage'),
] as const

export const adminRoleMiddleware = [
  authClientMiddleware,
  authRequestMiddleware,
  roleMiddleware('admin'),
] as const

async function getAuthStatusImplementation() {
  const authService = await getAuthService()

  return {
    needsSetup: await authService.needsSetup(),
    authEnabled: await authService.isAuthEnabled(),
  }
}

export const getAuthStatus = createServerFn({ method: 'GET' }).handler(
  getAuthStatusImplementation,
)
;(getAuthStatus as any).__executeImplementation = getAuthStatusImplementation

const setupImplementation = createServerOnlyFn(async (data: unknown) => {
  enforceAuthRateLimit(
    'setup',
    5,
    15 * 60 * 1000,
    'Too many setup attempts. Please try again later.',
    'RATE_LIMIT_SETUP',
  )
  const authService = await getAuthService()
  if (!(await authService.needsSetup())) {
    throwAuthError(
      'Setup already completed. Use login instead.',
      400,
      'SETUP_ALREADY_COMPLETED',
    )
  }

  const body = setupData(data)
  const { verifySetupToken, clearSetupToken } =
    await import('../../../panel-server/utils/setupToken.ts')
  if (!(await verifySetupToken(body.setupToken))) {
    throwAuthError(
      'Invalid or missing setup token',
      403,
      'SETUP_TOKEN_REQUIRED',
    )
  }

  try {
    const { setSetting } =
      await import('../../../panel-server/database/init.ts')
    await setSetting('panelPort', body.panelPort)
    await authService.createUser(body.username, body.password)
    await clearSetupToken()
    const result = await authService.login(
      body.username,
      body.password,
      body.rememberMe,
    )
    await setRefreshCookie(result.refreshToken)
    setResponseStatus(201)
    return {
      success: true,
      user: result.user,
      accessToken: result.accessToken,
    }
  } catch (error) {
    throwAuthError(errorMessage(error), 400)
  }
})

export const setup = createServerFn({ method: 'POST' })
  .validator((data: unknown) => data ?? {})
  .handler(({ data }) => setupImplementation(data))
;(setup as any).__executeImplementation = setupImplementation

const loginImplementation = createServerOnlyFn(async (data: unknown) => {
  enforceAuthRateLimit(
    'login',
    5,
    60 * 1000,
    'Too many login attempts. Please try again later.',
    'RATE_LIMIT_LOGIN',
  )
  const { username, password, rememberMe } = loginData(data)
  const authService = await getAuthService()
  try {
    const result = await authService.login(username, password, rememberMe)
    await setRefreshCookie(result.refreshToken)
    return {
      success: true,
      user: result.user,
      accessToken: result.accessToken,
    }
  } catch (error) {
    throwAuthError(errorMessage(error), 401)
  }
})

export const login = createServerFn({ method: 'POST' })
  .validator((data: unknown) => data ?? {})
  .handler(({ data }) => loginImplementation(data))
;(login as any).__executeImplementation = loginImplementation

const refreshImplementation = createServerOnlyFn(async () => {
  const authService = await getAuthService()
  const refreshToken = getCookie('refreshToken')
  if (!refreshToken) {
    throwAuthError('No refresh token', 401, 'NO_REFRESH_TOKEN')
  }

  try {
    const result = await authService.refreshAccessToken(refreshToken)
    if (!result) {
      await clearRefreshCookieForRequest()
      throwAuthError('Invalid refresh token', 401, 'INVALID_REFRESH_TOKEN')
    }
    await setRefreshCookie(result.refreshToken)
    return {
      success: true,
      user: result.user,
      accessToken: result.accessToken,
    }
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      (error as { code?: unknown }).code === 'INVALID_REFRESH_TOKEN'
    ) {
      throw error
    }
    try {
      await clearRefreshCookieForRequest()
    } catch {
      // The 401 response remains the useful result if headers are unavailable.
    }
    throwAuthError('Token refresh failed', 401, 'TOKEN_REFRESH_FAILED')
  }
})

export const refresh = createServerFn({ method: 'POST' }).handler(() =>
  refreshImplementation(),
)
;(refresh as any).__executeImplementation = refreshImplementation

const logoutImplementation = createServerOnlyFn(async () => {
  const authService = await getAuthService()
  await authService.logout(getCookie('refreshToken'))
  await clearRefreshCookieForRequest()
  return { success: true }
})

export const logout = createServerFn({ method: 'POST' }).handler(() =>
  logoutImplementation(),
)
;(logout as any).__executeImplementation = logoutImplementation

const resetStatusImplementation = createServerOnlyFn(async () => {
  try {
    const { getResetTokenState, isLocalPanelRequest } =
      await import('../../../panel-server/services/passwordRecovery.ts')
    const tokenState = getResetTokenState()
    return {
      resetAvailable: tokenState.available,
      localResetSupported: isLocalPanelRequest(getRequest()),
    }
  } catch {
    return { resetAvailable: false, localResetSupported: false }
  }
})

export const resetStatus = createServerFn({ method: 'GET' }).handler(() =>
  resetStatusImplementation(),
)
;(resetStatus as any).__executeImplementation = resetStatusImplementation

const createLocalResetTokenImplementation = createServerOnlyFn(async () => {
  enforceAuthRateLimit(
    'local-reset',
    5,
    15 * 60 * 1000,
    'Too many local recovery attempts. Please try again later.',
    'RATE_LIMIT_LOCAL_RECOVERY',
  )
  const {
    createLocalResetResponse,
    createLocalResetToken,
    getResetTokenState,
    isLocalPanelRequest,
    isPanelBehindTrustProxy,
  } = await import('../../../panel-server/services/passwordRecovery.ts')
  const request = getRequest()
  if (!isLocalPanelRequest(request)) {
    if (isPanelBehindTrustProxy(request)) {
      throwAuthError(
        "This panel is running behind a reverse proxy, so it can't verify a request came from the server itself. Create data/reset-token.txt on the host directly, or use a recovery code instead.",
        403,
        'LOCAL_RESET_BEHIND_PROXY',
      )
    }
    throwAuthError(
      'This recovery action is only available when the panel is opened from the server itself.',
      403,
      'LOCAL_RESET_NOT_LOCAL',
    )
  }

  try {
    if (getResetTokenState().available) {
      return createLocalResetResponse(
        'A recovery token is already available at data/reset-token.txt. Paste it below to continue.',
      )
    }
    createLocalResetToken()
    return createLocalResetResponse(
      'Recovery token created at data/reset-token.txt. Paste it below to continue.',
    )
  } catch {
    throwAuthError(
      'Could not create a recovery token on this server.',
      500,
      'LOCAL_RESET_TOKEN_CREATE_FAILED',
    )
  }
})

export const createLocalResetToken = createServerFn({ method: 'POST' }).handler(
  () => createLocalResetTokenImplementation(),
)
;(createLocalResetToken as any).__executeImplementation =
  createLocalResetTokenImplementation

const resetPasswordImplementation = createServerOnlyFn(
  async (data: unknown) => {
    enforceAuthRateLimit(
      'reset',
      3,
      15 * 60 * 1000,
      'Too many reset attempts. Please try again later.',
      'RATE_LIMIT_RESET',
    )
    const body = record(data)
    const token = body.token
    const newPassword = body.newPassword
    if (
      typeof token !== 'string' ||
      !token ||
      typeof newPassword !== 'string' ||
      !newPassword
    ) {
      throwAuthError(
        'Token and new password are required',
        400,
        'RESET_PASSWORD_FIELDS_REQUIRED',
      )
    }
    if (newPassword.length > 128) {
      throwAuthError(
        'Password must be 128 characters or fewer',
        400,
        'RESET_PASSWORD_TOO_LONG',
      )
    }

    const { checkResetToken, removeResetToken } =
      await import('../../../panel-server/services/passwordRecovery.ts')
    const tokenCheck = checkResetToken(token)
    if (!tokenCheck.ok) {
      throwAuthError(tokenCheck.error, 403, tokenCheck.code)
    }

    const authService = await getAuthService()
    try {
      const result = await authService.resetPassword(newPassword)
      try {
        removeResetToken(tokenCheck.tokenPath)
      } catch {
        // Password reset has completed; a stale token is safer than reporting failure.
      }
      return {
        success: true,
        message: `Password reset for ${result.username}`,
      }
    } catch (error) {
      throwAuthError(errorMessage(error), 400)
    }
  },
)

export const resetPassword = createServerFn({ method: 'POST' })
  .validator((data: unknown) => data ?? {})
  .handler(({ data }) => resetPasswordImplementation(data))
;(resetPassword as any).__executeImplementation = resetPasswordImplementation

const recoverWithCodeImplementation = createServerOnlyFn(
  async (data: unknown) => {
    enforceAuthRateLimit(
      'reset',
      3,
      15 * 60 * 1000,
      'Too many reset attempts. Please try again later.',
      'RATE_LIMIT_RESET',
    )
    const body = record(data)
    if (
      typeof body.code !== 'string' ||
      !body.code ||
      typeof body.newPassword !== 'string' ||
      !body.newPassword
    ) {
      throwAuthError(
        'A recovery code and a new password are required',
        400,
        'RECOVERY_CODE_FIELDS_REQUIRED',
      )
    }
    const authService = await getAuthService()
    try {
      const result = await authService.redeemRecoveryCode(
        body.code,
        body.newPassword,
      )
      return {
        success: true,
        message: `Password reset for ${result.username}`,
        remaining: result.remaining,
      }
    } catch (error) {
      throwAuthError(errorMessage(error), 403)
    }
  },
)

export const recoverWithCode = createServerFn({ method: 'POST' })
  .validator((data: unknown) => data ?? {})
  .handler(({ data }) => recoverWithCodeImplementation(data))
;(recoverWithCode as any).__executeImplementation =
  recoverWithCodeImplementation

async function getOidcStatusImplementation() {
  const { getOidcSettings, isOidcConfigured } =
    await import('../../../panel-server/services/oidc.ts')
  const settings = await getOidcSettings()

  return {
    configured: isOidcConfigured(settings),
    providerName: settings.providerName,
  }
}

export const getOidcStatus = createServerFn({ method: 'GET' }).handler(
  getOidcStatusImplementation,
)
;(getOidcStatus as any).__executeImplementation = getOidcStatusImplementation

async function getRecoveryStatusImplementation() {
  const authService = await getAuthService()
  const status = await authService.getRecoveryCodeStatus()

  return { recoveryCodesAvailable: status.remaining > 0 }
}

export const getRecoveryStatus = createServerFn({ method: 'GET' }).handler(
  getRecoveryStatusImplementation,
)
;(getRecoveryStatus as any).__executeImplementation =
  getRecoveryStatusImplementation

async function getCurrentUserImplementation(context: unknown) {
  const user = (context as { authenticatedUser: AuthContextUser })
    .authenticatedUser
  if (user.authDisabled || !user.userId || !user.username) {
    throw Object.assign(new Error('Not authenticated'), {
      status: 401,
      code: 'NOT_AUTHENTICATED',
    })
  }

  const { getCapabilitiesForRole } =
    await import('../../../panel-server/services/permissions.ts')
  return {
    user: {
      id: user.userId,
      username: user.username,
      role: user.role,
      capabilities: await getCapabilitiesForRole(user.role),
    },
  }
}

export const getCurrentUser = createServerFn({ method: 'GET' })
  .middleware(protectedServerFunctionMiddleware)
  .handler(({ context }) => getCurrentUserImplementation(context))
;(getCurrentUser as any).__executeImplementation = (
  _data: unknown,
  context: unknown,
) => getCurrentUserImplementation(context)
