import type { PackageData } from '../src/types'
import { afterEach, expect, it, vi } from 'vitest'

const { fetchJsrPackageMetaMock, fetchPackageMock } = vi.hoisted(() => ({
  fetchJsrPackageMetaMock: vi.fn(),
  fetchPackageMock: vi.fn(),
}))

vi.mock('../src/utils/packument.ts', () => ({
  fetchJsrPackageMeta: fetchJsrPackageMetaMock,
  fetchPackage: fetchPackageMock,
}))

afterEach(() => {
  vi.restoreAllMocks()
  vi.resetModules()
  fetchJsrPackageMetaMock.mockReset()
  fetchPackageMock.mockReset()
})

it('dedupes concurrent requests for the same package', async () => {
  const packageData: PackageData = {
    tags: { latest: '5.8.3' },
    versions: ['5.8.3'],
  }

  let resolveFetch: ((value: PackageData) => void) | undefined
  const pendingFetch = new Promise<PackageData>((resolve) => {
    resolveFetch = resolve
  })

  fetchPackageMock.mockReturnValue(pendingFetch)

  const { getPackageData } = await import('../src/registries')
  const firstRequest = getPackageData('typescript', 'npm', '/tmp', 15000)
  const secondRequest = getPackageData('typescript', 'npm', '/tmp', 15000)

  expect(fetchPackageMock).toHaveBeenCalledTimes(1)
  expect(fetchPackageMock).toHaveBeenCalledWith('typescript', false, '/tmp', 15000, undefined, undefined)

  resolveFetch?.(packageData)

  await expect(Promise.all([firstRequest, secondRequest])).resolves.toStrictEqual([packageData, packageData])
})

it('shares a failed lookup with later requests until the next check', async () => {
  fetchPackageMock.mockRejectedValueOnce(new Error('Timeout requesting "typescript"'))
  fetchPackageMock.mockResolvedValue({ tags: { latest: '5.8.3' }, versions: ['5.8.3'] })

  const { getPackageData, resetFailedRequests } = await import('../src/registries')

  // e.g. two packages of a monorepo asking one after another
  const first = await getPackageData('typescript', 'npm', '/tmp', 15000)
  const second = await getPackageData('typescript', 'npm', '/tmp', 15000)

  expect(first.error).toBeDefined()
  expect(second).toBe(first)
  expect(fetchPackageMock).toHaveBeenCalledTimes(1)

  // a new check retries the failed package
  resetFailedRequests()
  await expect(getPackageData('typescript', 'npm', '/tmp', 15000)).resolves.toMatchObject({ versions: ['5.8.3'] })
  expect(fetchPackageMock).toHaveBeenCalledTimes(2)
})

it('resolves a dependency shared by many packages with one request under the queue', async () => {
  const { newQueue } = await import('@henrygd/queue')
  const { queueContext } = await import('../src/utils/context')
  const { resolveDependencies } = await import('../src/registries')

  const queue = newQueue(1)
  const started: string[] = []
  fetchPackageMock.mockImplementation(async (name: string) => {
    started.push(name)
    return { tags: { latest: '2.0.0' }, versions: ['1.0.0', '2.0.0'] }
  })

  const deps = ['a', 'a', 'a', 'b'].map(name => ({ name, currentVersion: '^1.0.0', source: 'dependencies' as const, update: true }))
  const resolved = await queueContext.run(queue, () => resolveDependencies(deps, { mode: 'major' }))

  expect(started).toEqual(['a', 'b'])
  expect(resolved.map(d => d.targetVersion)).toEqual(['^2.0.0', '^2.0.0', '^2.0.0', '^2.0.0'])
})
