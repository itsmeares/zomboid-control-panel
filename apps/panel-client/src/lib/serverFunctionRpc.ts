export type ServerFunctionOptions = {
  data?: unknown
  context?: unknown
}

type ServerFunction = {
  __executeServer?: (
    options: ServerFunctionOptions,
  ) => Promise<{
    result?: unknown
    error?: unknown
    context?: unknown
  }>
  __executeImplementation?: (
    data?: unknown,
    context?: unknown,
  ) => Promise<unknown> | unknown
}

export async function invokeServerFunction<T>(
  serverFunction: unknown,
  name: string,
  options: ServerFunctionOptions,
): Promise<T> {
  const typedServerFunction = serverFunction as ServerFunction | undefined
  const executeServer = typedServerFunction?.__executeServer
  if (!executeServer) {
    throw new Error(`Server function ${name} is not available`)
  }

  const outcome = await executeServer(options)
  if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)) {
    throw new Error(`Server function ${name} returned a malformed result`)
  }
  if (outcome.error) throw outcome.error

  if (outcome.result !== undefined) return outcome.result as T

  const executeImplementation = typedServerFunction.__executeImplementation
  if (!executeImplementation) {
    throw new Error(`Server function ${name} returned no result`)
  }

  // The production transform leaves the extracted handler empty. Its
  // middleware still runs, so reuse the resulting context before invoking the
  // server-only implementation hook.
  return (await executeImplementation(
    options.data,
    outcome.context ?? options.context,
  )) as T
}
