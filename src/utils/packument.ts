import type { PackageVersionsInfoWithMetadata } from 'get-npm-meta'
import type { JsrPackageMeta, PackageData, RetryOptions } from '../types'
import process from 'node:process'
import { getVersions } from 'get-npm-meta'
import { fetch as ofetch } from 'ofetch'

const DEFAULT_REQUEST_TIMEOUT = 5000
const DEFAULT_RETRIES = 4
const JSR_API_REGISTRY = 'https://jsr.io/'
const USER_AGENT = `taze@npm node/${process.version}`

// @types/pacote uses "import = require()" syntax which is not supported by unbuild
// So instead of using @types/pacote, we declare the type definition with only fields we need
export interface PackumentVersion {
  name: string
  deprecated?: string | boolean
  dist: {
    attestations: {
      provenance?: { predicateType: string }
    }
  }
}

export interface Packument {
  'name': string
  /**
   * An object where each key is a version, and each value is the manifest for
   * that version.
   */
  'versions': Record<string, PackumentVersion>
  /**
   * An object mapping dist-tags to version numbers. This is how `foo@latest`
   * gets turned into `foo@1.2.3`.
   */
  'dist-tags': { latest: string } & Record<string, string>
  /**
   * In the full packument, an object mapping version numbers to publication
   * times, for the `opts.before` functionality.
   */
  'time': Record<string, string> & {
    created: string
    modified: string
  }
}

const fetchWithUserAgent: typeof fetch = (input, init) => {
  const headers = new Headers(init?.headers)
  headers.set('user-agent', USER_AGENT)
  return ofetch(input, { ...init, headers })
}

function createTimeoutError(name: string) {
  return new Error(`Timeout requesting "${name}"`)
}

async function withRequestTimeout<T>(name: string, timeout: number, run: (signal: AbortSignal) => Promise<T>) {
  const controller = new AbortController()
  const timeoutError = createTimeoutError(name)
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(timeoutError)
      controller.abort(timeoutError)
    }, timeout)
  })

  try {
    return await Promise.race([run(controller.signal), timeoutPromise])
  }
  finally {
    if (timeoutId)
      clearTimeout(timeoutId)

    controller.abort(timeoutError)
  }
}

interface NormalizedRetryOptions {
  retries: number
  factor: number
  minTimeout: number
  maxTimeout: number
  randomize: boolean
}

function normalizeRetry(retry: number | false | RetryOptions): NormalizedRetryOptions | false {
  if (retry === false)
    return false
  // mirrors the defaults of get-npm-meta / fast-npm-meta (p-retry)
  const defaults = { retries: DEFAULT_RETRIES, factor: 2, minTimeout: 1000, maxTimeout: Number.POSITIVE_INFINITY, randomize: false }
  if (typeof retry === 'number')
    return { ...defaults, retries: retry }
  return { ...defaults, ...retry }
}

/**
 * Upper bound for the whole lookup: every attempt may use the full
 * `requestTimeout`, plus the back-off between attempts. This is only a safety
 * net for upstreams that ignore abort; normally each attempt is bounded by its
 * own timeout (see {@link createAttemptFetch}).
 */
function getTotalTimeout(requestTimeout: number, retry: NormalizedRetryOptions | false) {
  if (!retry)
    return requestTimeout
  let total = requestTimeout * (retry.retries + 1)
  for (let i = 0; i < retry.retries; i++)
    total += Math.min(retry.minTimeout * (retry.randomize ? 2 : 1) * retry.factor ** i, retry.maxTimeout)
  return Number.isFinite(total) ? total : requestTimeout * (retry.retries + 1)
}

/**
 * A `fetch` that gives each call (i.e. each retry attempt) its own
 * `requestTimeout`, covering both the headers and the body download.
 *
 * Previously one timer covered all attempts together. With the default
 * back-off (1s, 2s, 4s, ...) a retry could barely start before the 5s budget
 * ran out, so any transient failure became a hard error for that package.
 */
function createAttemptFetch(name: string, requestTimeout: number, outerSignal: AbortSignal) {
  const timers = new Set<ReturnType<typeof setTimeout>>()

  const attemptFetch: typeof fetch = (input, init) => {
    const controller = new AbortController()
    const timeoutError = createTimeoutError(name)
    const onOuterAbort = () => controller.abort(outerSignal.reason)
    if (outerSignal.aborted)
      onOuterAbort()
    else
      outerSignal.addEventListener('abort', onOuterAbort, { once: true })

    let timeoutId: ReturnType<typeof setTimeout>
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        timers.delete(timeoutId)
        reject(timeoutError)
        controller.abort(timeoutError)
      }, requestTimeout)
      timers.add(timeoutId)
    })
    // the timer stays armed while the body is read; it is cleared by `dispose`
    timeoutPromise.catch(() => {})

    return Promise.race([fetchWithUserAgent(input, { ...init, signal: controller.signal }), timeoutPromise])
  }

  const dispose = () => {
    for (const id of timers)
      clearTimeout(id)
    timers.clear()
  }

  return { fetch: attemptFetch, dispose }
}

export async function fetchPackage(spec: string, force: boolean = false, cwd?: string, requestTimeout: number = DEFAULT_REQUEST_TIMEOUT, retry: number | false | RetryOptions = DEFAULT_RETRIES, fastNpmMetaApiEndpoint?: string): Promise<PackageData> {
  const retryOptions = normalizeRetry(retry)
  const data = await withRequestTimeout(spec, getTotalTimeout(requestTimeout, retryOptions), async (signal) => {
    const attempt = createAttemptFetch(spec, requestTimeout, signal)
    try {
      return await getVersions(spec, {
        apiEndpoint: fastNpmMetaApiEndpoint,
        // an empty string counts as an explicit directory, which would resolve
        // registry config against `''` instead of the directory being checked
        cwd: cwd || process.cwd(),
        force,
        fetch: attempt.fetch,
        metadata: true,
        throw: false,
        retry: retryOptions,
      }) as PackageVersionsInfoWithMetadata
    }
    finally {
      attempt.dispose()
    }
  })

  if ('error' in data)
    throw new Error(`Failed to fetch package "${spec}": ${data.error}`)

  return toPackageData(data)
}

export async function fetchJsrPackageMeta(name: string, requestTimeout: number = DEFAULT_REQUEST_TIMEOUT): Promise<PackageData> {
  const meta = await withRequestTimeout(name, requestTimeout, async (signal) => {
    const res = await fetchWithUserAgent(new URL(`${name}/meta.json`, JSR_API_REGISTRY), {
      signal,
      headers: {
        accept: 'application/json',
      },
    })
    // JSR returns a plain-text `404 - Not Found` body for unknown packages,
    // which would otherwise blow up JSON parsing with an opaque SyntaxError.
    if (!res.ok)
      throw new Error(`Failed to fetch JSR package "${name}": ${res.status} ${res.statusText}`)
    return await res.json() as JsrPackageMeta
  })

  return {
    // Yanked versions are unpublished-in-place; never offer them as targets.
    versions: Object.entries(meta.versions)
      .filter(([, info]) => !info?.yanked)
      .map(([version]) => version),
    tags: { latest: meta.latest },
  }
}

function toPackageData(data: PackageVersionsInfoWithMetadata): PackageData {
  const versions = Object.keys(data.versionsMeta)
  const deprecated = Object.fromEntries(
    Object.entries(data.versionsMeta)
      .filter(([, meta]) => meta.deprecated)
      .map(([version, meta]) => [version, meta.deprecated!]),
  )
  const nodeSemver = Object.fromEntries(
    Object.entries(data.versionsMeta)
      .map(([version, meta]) => [version, meta.engines?.node])
      .filter(([, node]) => node),
  )
  const provenance = Object.fromEntries(
    Object.entries(data.versionsMeta)
      .map(([version, meta]) => [version, meta.provenance])
      .filter(([, value]) => value),
  )
  const integrity = Object.fromEntries(
    Object.entries(data.versionsMeta)
      .map(([version, meta]) => [version, meta.integrity])
      .filter(([, value]) => value),
  )

  return {
    tags: data.distTags,
    versions,
    time: {
      ...Object.fromEntries(
        Object.entries(data.versionsMeta)
          .filter(([, meta]) => meta.time)
          .map(([version, meta]) => [version, meta.time!]),
      ),
      created: data.timeCreated,
      modified: data.timeModified,
    },
    nodeSemver,
    provenance,
    deprecated: Object.keys(deprecated).length > 0 ? deprecated : undefined,
    integrity,
  }
}
