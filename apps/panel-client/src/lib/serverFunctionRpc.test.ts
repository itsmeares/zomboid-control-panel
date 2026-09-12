import { describe, expect, it, vi } from 'vitest'
import { invokeServerFunction } from './serverFunctionRpc'

describe('invokeServerFunction', () => {
  it('passes the RPC payload to the server function and returns its result', async () => {
    const serverFunction = {
      __executeServer: vi.fn(async () => ({ result: { ok: true } })),
    }
    const options = { data: { id: 'server-1' }, context: { requestId: 'test' } }

    await expect(
      invokeServerFunction(serverFunction, 'getServer', options),
    ).resolves.toEqual({ ok: true })
    expect(serverFunction.__executeServer).toHaveBeenCalledWith(options)
  })

  it('rethrows a server function error without replacing it', async () => {
    const error = new Error('permission denied')
    const serverFunction = {
      __executeServer: vi.fn(async () => ({ error })),
    }

    await expect(
      invokeServerFunction(serverFunction, 'getServer', {}),
    ).rejects.toBe(error)
  })

  it('runs the implementation after middleware returns an empty result', async () => {
    const executeImplementation = vi.fn(
      async (data: unknown, context: unknown) => ({ data, context }),
    )
    const serverFunction = {
      __executeServer: vi.fn(async () => ({
        result: undefined,
        error: undefined,
        context: { authenticatedUser: { id: 'user-1' } },
      })),
      __executeImplementation: executeImplementation,
    }
    const options = { data: { id: 'server-1' }, context: { requestId: 'test' } }

    await expect(
      invokeServerFunction(serverFunction, 'getServer', options),
    ).resolves.toEqual({
      data: { id: 'server-1' },
      context: { authenticatedUser: { id: 'user-1' } },
    })
    expect(executeImplementation).toHaveBeenCalledWith(options.data, {
      authenticatedUser: { id: 'user-1' },
    })
  })

  it('returns middleware responses without invoking the implementation', async () => {
    const executeImplementation = vi.fn()
    const response = new Response('permission denied', { status: 403 })
    const serverFunction = {
      __executeServer: vi.fn(async () => ({ result: response })),
      __executeImplementation: executeImplementation,
    }

    await expect(
      invokeServerFunction(serverFunction, 'saveServer', {}),
    ).resolves.toBe(response)
    expect(executeImplementation).not.toHaveBeenCalled()
  })

  it('does not hide an empty result when no implementation is available', async () => {
    const serverFunction = {
      __executeServer: vi.fn(async () => ({
        result: undefined,
        error: undefined,
      })),
    }

    await expect(
      invokeServerFunction(serverFunction, 'getServer', {}),
    ).rejects.toThrow('Server function getServer returned no result')
  })

  it('fails clearly when the server outcome is malformed', async () => {
    const serverFunction = {
      __executeServer: vi.fn(async () => undefined),
    }

    await expect(
      invokeServerFunction(serverFunction, 'getServer', {}),
    ).rejects.toThrow('Server function getServer returned a malformed result')
  })

  it('fails clearly when a server function is not available', async () => {
    await expect(invokeServerFunction({}, 'getServer', {})).rejects.toThrow(
      'Server function getServer is not available',
    )
  })

  it('rejects array outcomes as malformed', async () => {
    const executeImplementation = vi.fn()
    const serverFunction = {
      __executeServer: vi.fn(async () => []),
      __executeImplementation: executeImplementation,
    }

    await expect(
      invokeServerFunction(serverFunction, 'getServer', {}),
    ).rejects.toThrow('Server function getServer returned a malformed result')
    expect(executeImplementation).not.toHaveBeenCalled()
  })
})
