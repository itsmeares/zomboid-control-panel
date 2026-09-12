import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-start', () => ({
  createServerFn: () => ({
    handler:
      (handler: (args: { data: undefined; context: undefined }) => unknown) =>
      () =>
        handler({ data: undefined, context: undefined }),
  }),
}))

vi.mock('../serverAuth.server', () => ({
  getAuthStatus: {
    __executeServer: async () => ({ result: undefined, error: undefined }),
  },
  getOidcStatus: {},
  getRecoveryStatus: {},
  getCurrentUser: {},
}))

import { getAuthStatusWithFallback } from '../serverAuth'

describe('auth status fallback', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uses the public auth endpoint when the Start function returns no result', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('Forbidden', { status: 403 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ needsSetup: false, authEnabled: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
    vi.stubGlobal('fetch', fetchMock)

    await expect(getAuthStatusWithFallback()).resolves.toEqual({
      needsSetup: false,
      authEnabled: true,
    })
    expect(fetchMock).toHaveBeenLastCalledWith('/api/auth/status')
  })

  it('rejects malformed status payloads instead of treating them as auth state', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ needsSetup: false }), { status: 200 }),
      )
    vi.stubGlobal('fetch', fetchMock)

    await expect(getAuthStatusWithFallback()).rejects.toThrow(
      'Auth status response was invalid',
    )
  })
})
