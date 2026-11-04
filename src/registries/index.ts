import type { CheckOptions, DependencyFilter, DependencyResolvedCallback, PackageMeta, PackageType, RawDep, ResolvedDepChange } from '../types'
import type { Registry } from './types'
import { newQueue } from '@henrygd/queue'
import { diffSorter } from '../filters/diff-sorter'
import { queueContext } from '../utils/context'
import { githubActionsRegistry } from './github-actions'
import { jsrRegistry } from './jsr'
import { nodeRegistry } from './node'
import { npmRegistry } from './npm'

export { dumpCache, loadCache, resetFailedRequests } from './cache'

export { getGitHubActionDiff } from './github-actions/registry'
export {
  getLatestVersionAvailable,
  getPackageData,
  getVersionOfRange,
  getVersionOfTag,
  isLocalPackage,
  isUrlPackage,
  updateTargetVersion,
} from './npm/registry'
export { getDiff } from './shared'
export type { Registry } from './types'

/**
 * All available registries, keyed by their {@link PackageType}. This is the
 * package-type axis registry — add an ecosystem by registering it here.
 */
export const registries = {
  'npm': npmRegistry,
  'github-actions': githubActionsRegistry,
  'jsr': jsrRegistry,
  'node': nodeRegistry,
} satisfies Record<PackageType, Registry>

export function getRegistry(packageType: PackageType = 'npm'): Registry {
  return registries[packageType] ?? registries.npm
}

export async function resolveDependency(
  raw: RawDep,
  options: CheckOptions,
  filter: DependencyFilter = () => true,
): Promise<ResolvedDepChange> {
  return getRegistry(raw.packageType).resolve(raw, options, filter)
}

export async function resolveDependencies(
  deps: RawDep[],
  options: CheckOptions,
  filter: DependencyFilter = () => true,
  progressCallback: (name: string, counter: number, total: number) => void = () => {},
) {
  const total = deps.length
  let counter = 0

  const {
    concurrency = 10,
  } = options

  const run = () => Promise.all(
    deps.map(async (raw) => {
      const dep = await resolveDependency(raw, options, filter)
      counter += 1
      progressCallback(raw.name, counter, total)
      return dep
    }),
  )

  // The queue limits network requests, not resolutions (see `getCachedData`),
  // so a dependency that is cached or already in flight never waits behind
  // unrelated requests. resolveDependencies may be called standalone without
  // going through CheckPackages, so fall back to a queue that respects the
  // concurrency option.
  if (queueContext.getStore())
    return run()
  return queueContext.run(newQueue(concurrency), run)
}

export async function resolvePackage(pkg: PackageMeta, options: CheckOptions, filter?: DependencyFilter, progress?: DependencyResolvedCallback) {
  const resolved = await resolveDependencies(pkg.deps, options, filter, (name, counter, total) => progress?.(pkg.name, name, counter, total))
  diffSorter(resolved)
  pkg.resolved = resolved
  return pkg
}
