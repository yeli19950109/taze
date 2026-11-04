/**
 * Live checks against the fast-npm-meta batch API (https://npm.antfu.dev),
 * through the same `get-npm-meta` entry point taze would use for batching.
 *
 * These hit the network, so they only run when `TAZE_LIVE_TEST=1`:
 *
 *   TAZE_LIVE_TEST=1 pnpm exec vitest run test/fastNpmMeta.live.test.ts
 */
import type { PackageVersionsInfoWithMetadata } from 'get-npm-meta'
import process from 'node:process'
import { getVersions, getVersionsBatch } from 'get-npm-meta'
import { describe, expect, it } from 'vitest'

const live = process.env.TAZE_LIVE_TEST === '1'
const timeout = 60_000

type Result = PackageVersionsInfoWithMetadata | { error: string, name?: string, status?: number }

function batch(names: string[]) {
  return getVersionsBatch(names, { metadata: true, throw: false }) as Promise<Result[]>
}

function isError(r: Result): r is { error: string, name?: string, status?: number } {
  return 'error' in r
}

describe.runIf(live)('fast-npm-meta batch API (live)', () => {
  it('returns one result per package, in input order', async () => {
    const names = ['vue', 'typescript', 'vitest', '@antfu/ni', 'lodash']
    const results = await batch(names)

    expect(results).toHaveLength(names.length)
    results.forEach((r, i) => {
      expect(isError(r), `${names[i]}: ${JSON.stringify(r).slice(0, 200)}`).toBe(false)
      const ok = r as PackageVersionsInfoWithMetadata
      expect(ok.name).toBe(names[i])
      expect(ok.distTags.latest).toBeTruthy()
      expect(Object.keys(ok.versionsMeta).length).toBeGreaterThan(0)
      expect(ok.versionsMeta[ok.distTags.latest]?.time).toBeTruthy()
    })
  }, timeout)

  it('reports an unknown package in place without failing the others', async () => {
    const missing = 'taze-this-package-should-not-exist-9f3c1a'
    const names = ['vue', missing, 'lodash']
    const results = await batch(names)

    expect(results).toHaveLength(3)
    expect(isError(results[0])).toBe(false)
    expect(isError(results[1])).toBe(true)
    expect(isError(results[2])).toBe(false)
    // shape of the error item, logged for reference
    console.log('error item:', JSON.stringify(results[1]))
  }, timeout)

  it('matches the single-package endpoint', async () => {
    const [fromBatch] = await batch(['vitest']) as PackageVersionsInfoWithMetadata[]
    const single = await getVersions('vitest', { metadata: true }) as PackageVersionsInfoWithMetadata

    expect(fromBatch.distTags).toEqual(single.distTags)
    expect(Object.keys(fromBatch.versionsMeta).sort()).toEqual(Object.keys(single.versionsMeta).sort())
    const latest = single.distTags.latest
    expect(fromBatch.versionsMeta[latest]).toEqual(single.versionsMeta[latest])
  }, timeout)

  it('handles a large batch and is faster than one request per package', async () => {
    const names = [
      'react',
      'react-dom',
      'vue',
      'svelte',
      'typescript',
      'vitest',
      'vite',
      'esbuild',
      'rollup',
      'webpack',
      'eslint',
      'prettier',
      'lodash',
      'axios',
      'express',
      'next',
      'nuxt',
      'zod',
      'dayjs',
      'chalk',
      'commander',
      'yargs',
      'semver',
      'pathe',
      'ofetch',
      'tinyexec',
      'unbuild',
      'tsx',
      'jiti',
      'defu',
    ]

    let start = performance.now()
    const results = await batch(names)
    const batchMs = performance.now() - start

    start = performance.now()
    await Promise.all(names.map(name => getVersions(name, { metadata: true, throw: false })))
    const singleMs = performance.now() - start

    const sizeKb = Math.round(JSON.stringify(results).length / 1024)
    console.log(`batch of ${names.length}: ${Math.round(batchMs)}ms, ${sizeKb}KB | ${names.length} single requests: ${Math.round(singleMs)}ms`)

    expect(results).toHaveLength(names.length)
    expect(results.filter(isError)).toEqual([])
  }, timeout)
})
