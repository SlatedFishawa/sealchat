let fflatePromise: Promise<typeof import('fflate')> | null = null

const loadFflate = () => {
  fflatePromise ??= import('fflate')
  return fflatePromise
}

export const inflateRaw = async (data: Uint8Array, expectedSize?: number): Promise<Uint8Array> => {
  const { inflate } = await loadFflate()

  return new Promise<Uint8Array>((resolve, reject) => {
    const callback = (error: Error | null, result: Uint8Array) => {
      if (error) {
        reject(error)
        return
      }
      resolve(result)
    }

    if (expectedSize === undefined) {
      inflate(data, callback)
      return
    }
    inflate(data, { size: expectedSize }, callback)
  })
}
