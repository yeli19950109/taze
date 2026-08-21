import type { CommonOptions, PackageMeta } from '../types'
import type { Manifest } from './types'
import process from 'node:process'
import { up as findUp } from 'empathic/find'
import { createDebug } from 'obug'
import { dirname, join, resolve } from 'pathe'
import { glob } from 'tinyglobby'
import { DEFAULT_IGNORE_PATHS } from '../constants'
import { createDependenciesFilter } from '../utils/dependenciesFilter'
import { bunWorkspaceManifest } from './bun-workspace'
import { githubActionsManifest } from './github-action'
import { nodeVersionManifest } from './node-version'
import { packageJsonManifest } from './package-json'
import { packageYamlManifest } from './package-yaml'
import { pnpmWorkspaceManifest } from './pnpm-workspace'
import { yarnWorkspaceManifest } from './yarn-workspace'

const debug = createDebug('taze:workspace')

export { dumpDependencies, parseDependencies } from './dependencies'
export type { Manifest } from './types'

/**
 * The built-in manifests — the file-source axis. Register a new built-in file
 * source by adding it here; discovery and write routing pick it up
 * automatically. Users can supply extra ones via `options.manifests`.
 */
export const builtinManifests: Manifest[] = [
  yarnWorkspaceManifest,
  pnpmWorkspaceManifest,
  packageJsonManifest,
  packageYamlManifest,
  bunWorkspaceManifest,
  githubActionsManifest,
  nodeVersionManifest,
]

/**
 * The effective manifest list for the given options: user-provided custom
 * manifests first (so they take precedence when matching / routing writes),
 * followed by the built-ins.
 */
export function getManifests(options: CommonOptions): Manifest[] {
  return options.manifests?.length
    ? [...options.manifests, ...builtinManifests]
    : builtinManifests
}

function isManifestEnabled(manifest: Manifest, options: CommonOptions): boolean {
  return manifest.enabled?.(options) ?? true
}

export async function writePackage(
  pkg: PackageMeta,
  options: CommonOptions,
) {
  const manifest = getManifests(options).find(m =>
    Array.isArray(m.type) ? m.type.includes(pkg.type as any) : m.type === pkg.type,
  )
  if (!manifest)
    throw new Error(`Unsupported package type: ${pkg.type}`)
  return manifest.write(pkg, options)
}

export async function loadPackage(
  relative: string,
  options: CommonOptions,
  shouldUpdate: (name: string) => boolean,
): Promise<PackageMeta[]> {
  const filepath = resolve(options.cwd ?? '', relative)
  const manifest = getManifests(options).find(m => isManifestEnabled(m, options) && m.match(filepath))
    ?? packageJsonManifest
  debug('load %s with manifest=%s', relative, manifest.name)
  return manifest.load(relative, options, shouldUpdate)
}

/**
 * Discover `package.json` / `package.yaml` files. package.yaml takes priority
 * over package.json in the same directory, and `ignoreOtherWorkspaces` prunes
 * nested packages that belong to a different workspace root.
 */
async function discoverPackageFiles(options: CommonOptions): Promise<string[]> {
  const cwd = resolve(options.cwd || process.cwd())
  const ignore = DEFAULT_IGNORE_PATHS.concat(options.ignorePaths || [])
  let packagesNames: string[] = []

  debug(
    'scan root=%s recursive=%s ignoreOtherWorkspaces=%s',
    cwd,
    !!options.recursive,
    !!options.ignoreOtherWorkspaces,
  )
  debug('ignore patterns=%O', ignore)

  if (options.recursive) {
    // Look for both package.yaml and package.json files
    const yamlPackages = await glob('**/package.yaml', {
      ignore,
      cwd: options.cwd,
      onlyFiles: true,
      dot: false,
      expandDirectories: false,
    })

    const jsonPackages = await glob('**/package.json', {
      ignore,
      cwd: options.cwd,
      onlyFiles: true,
      dot: false,
      expandDirectories: false,
    })

    // Prioritize package.yaml over package.json in the same directory
    const packageDirs = new Set<string>()

    // Add all package.yaml files first (higher priority)
    for (const yamlPkg of yamlPackages) {
      packagesNames.push(yamlPkg)
      const dir = dirname(yamlPkg)
      packageDirs.add(dir)
    }

    // Add package.json files only if no package.yaml exists in the same directory
    for (const jsonPkg of jsonPackages) {
      const dir = dirname(jsonPkg)
      if (!packageDirs.has(dir)) {
        packagesNames.push(jsonPkg)
      }
      else {
        debug('exclude %s: package.yaml takes precedence in the same directory', jsonPkg)
      }
    }
  }
  else {
    packagesNames = await glob('package.{yaml,json}', { cwd })
  }

  packagesNames = packagesNames.sort((a, b) => a.localeCompare(b))
  debug('package manifest candidates=%O', packagesNames)

  if (options.ignoreOtherWorkspaces) {
    packagesNames = (await Promise.all(
      packagesNames.map(async (packagePath) => {
        if (!packagePath.includes('/'))
          return [packagePath]

        const absolute = join(cwd, packagePath)
        const gitDir = findUp('.git', { cwd: absolute, last: cwd })
        if (gitDir && dirname(gitDir) !== cwd) {
          debug('exclude %s: nested Git root at %s', packagePath, dirname(gitDir))
          return []
        }
        const pnpmWorkspace = findUp('pnpm-workspace.yaml', { cwd: absolute, last: cwd })
        if (pnpmWorkspace && dirname(pnpmWorkspace) !== cwd) {
          debug('exclude %s: nested pnpm workspace at %s', packagePath, dirname(pnpmWorkspace))
          return []
        }
        const yarnWorkspace = findUp('.yarnrc.yml', { cwd: absolute, last: cwd })
        if (yarnWorkspace && dirname(yarnWorkspace) !== cwd) {
          debug('exclude %s: nested Yarn workspace at %s', packagePath, dirname(yarnWorkspace))
          return []
        }
        const bunLock = findUp('bun.lockb', { cwd: absolute, last: cwd })
          || findUp('bun.lock', { cwd: absolute, last: cwd })
        if (bunLock && dirname(bunLock) !== cwd) {
          debug('exclude %s: nested Bun workspace at %s', packagePath, dirname(bunLock))
          return []
        }
        return [packagePath]
      }),
    )).flat()
  }

  debug('selected package manifests=%O', packagesNames)

  return packagesNames
}

export async function loadPackages(options: CommonOptions): Promise<PackageMeta[]> {
  const filter = createDependenciesFilter(options.include, options.exclude)

  // Collect discovery results from every source, tagged with a load order.
  // package.json / package.yaml share the core discovery (order 0); catalog
  // files load before them (negative order) and GitHub Actions after (order 1).
  const groups: { order: number, paths: string[] }[] = [
    { order: 0, paths: await discoverPackageFiles(options) },
  ]

  for (const manifest of getManifests(options)) {
    if (!manifest.discover)
      continue
    if (!isManifestEnabled(manifest, options)) {
      debug('manifest %s disabled', manifest.name)
      continue
    }
    const paths = await manifest.discover(options)
    debug('manifest %s discovered=%O', manifest.name, paths)
    groups.push({ order: manifest.order ?? 0, paths })
  }

  groups.sort((a, b) => a.order - b.order)
  const packagesNames = groups.flatMap(g => g.paths)

  const packages = (await Promise.all(
    packagesNames.map(
      relative => loadPackage(relative, options, filter),
    ),
  )).flat()

  for (const pkg of packages) {
    const kind = pkg.type === 'package.json' || pkg.type === 'package.yaml'
      ? 'workspace'
      : 'manifest'
    debug(
      `${kind} path=%s name=%s type=%s private=%s dependencies=%O`,
      pkg.relative,
      pkg.name || '(unnamed)',
      pkg.type,
      pkg.private,
      pkg.deps.map(dep => ({
        name: dep.name,
        version: dep.currentVersion,
        source: dep.source,
        packageType: dep.packageType ?? dep.protocol ?? 'npm',
      })),
    )
  }
  const workspaceCount = packages.filter(pkg => pkg.type === 'package.json' || pkg.type === 'package.yaml').length
  debug('loaded workspaces=%d total manifests=%d', workspaceCount, packages.length)

  return packages
}
