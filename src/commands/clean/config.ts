import type { CleanConfig, CleanProfile, CleanSizeUnit, CleanSortBy, NpkillrcConfig } from './types'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { DEFAULT_PROFILE, DEFAULT_PROFILES } from './profiles'
import { getHomeDir } from './risk'
import { CLEAN_SIZE_UNITS, CLEAN_SORT_CHOICES } from './types'

const NPKILLRC_FILENAME = '.npkillrc'

export class CleanConfigError extends Error {}

export interface CleanCliOptions {
  directory?: string
  full?: boolean
  profiles?: string | boolean
  targets?: string
  exclude?: string
  excludeSensitive?: boolean
  deleteAll?: boolean
  yes?: boolean
  dryRun?: boolean
  json?: boolean
  jsonStream?: boolean
  size?: boolean
  age?: boolean
  stats?: boolean
  olderThan?: string | number
  sort?: string
  sizeUnit?: string
  hideErrors?: boolean
  config?: string
  concurrency?: string | number
}

export interface ResolvedClean {
  config: CleanConfig
  /** Built-in profiles merged with the ones from `.npkillrc` */
  profiles: Record<string, CleanProfile>
  /** `-p` was passed without a value: list the profiles and exit */
  listProfiles: boolean
  /** Path of the loaded `.npkillrc`, if any */
  configPath?: string
}

export const DEFAULT_CLEAN_CONFIG: CleanConfig = {
  rootDir: '.',
  targets: [],
  profiles: [DEFAULT_PROFILE],
  exclude: [],
  excludeSensitiveResults: false,
  deleteAll: false,
  yes: false,
  dryRun: false,
  json: false,
  jsonStream: false,
  disableSize: false,
  disableAge: false,
  olderThan: 0,
  sortBy: 'none',
  sizeUnit: 'auto',
  hideErrors: false,
  concurrency: 16,
}

function splitList(value: unknown): string[] {
  if (value === undefined || value === null || typeof value === 'boolean')
    return []
  return (Array.isArray(value) ? value : [value])
    .flatMap(v => String(v).split(','))
    .map(v => v.trim())
    .filter(Boolean)
}

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(i => typeof i === 'string')

/** Validates an `.npkillrc` object. Returns an error message or `undefined`. */
function validateNpkillrc(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return 'Configuration must be a JSON object.'
  const config = raw as Record<string, unknown>
  const known = ['rootDir', 'exclude', 'sortBy', 'sizeUnit', 'excludeSensitiveResults', 'dryRun', 'checkUpdates', 'defaultProfiles', 'profiles', '$schema']
  for (const key of Object.keys(config)) {
    if (!known.includes(key))
      return `Unknown property "${key}".`
  }
  if (config.rootDir !== undefined && typeof config.rootDir !== 'string')
    return '"rootDir" must be a string.'
  if (config.exclude !== undefined && !isStringArray(config.exclude))
    return '"exclude" must be an array of strings.'
  if (config.sortBy !== undefined && !CLEAN_SORT_CHOICES.includes(config.sortBy as CleanSortBy))
    return `"sortBy" must be one of: ${CLEAN_SORT_CHOICES.join(', ')}.`
  if (config.sizeUnit !== undefined && !CLEAN_SIZE_UNITS.includes(config.sizeUnit as CleanSizeUnit))
    return `"sizeUnit" must be one of: ${CLEAN_SIZE_UNITS.join(', ')}.`
  for (const key of ['excludeSensitiveResults', 'dryRun', 'checkUpdates']) {
    if (config[key] !== undefined && typeof config[key] !== 'boolean')
      return `"${key}" must be a boolean.`
  }
  if (config.defaultProfiles !== undefined && !isStringArray(config.defaultProfiles))
    return '"defaultProfiles" must be an array of strings.'
  if (config.profiles !== undefined) {
    if (typeof config.profiles !== 'object' || config.profiles === null || Array.isArray(config.profiles))
      return '"profiles" must be an object.'
    for (const [name, profile] of Object.entries(config.profiles as Record<string, unknown>)) {
      const p = profile as Record<string, unknown> | null
      if (typeof p !== 'object' || p === null || !isStringArray(p.targets) || p.targets.length === 0)
        return `Profile "${name}" must have a non-empty "targets" array.`
      if (p.description !== undefined && typeof p.description !== 'string')
        return `Profile "${name}" has an invalid "description".`
    }
  }
  return undefined
}

/**
 * Loads `.npkillrc` (JSON). Priority: `--config` > `./.npkillrc` > `~/.npkillrc`.
 */
function loadNpkillrc(customPath?: string, cwd = process.cwd(), home = getHomeDir()): { config?: NpkillrcConfig, path?: string } {
  let path: string | undefined
  if (customPath) {
    path = resolve(cwd, customPath)
    if (!existsSync(path))
      throw new CleanConfigError(`Config file not found: ${path}`)
  }
  else {
    path = [join(cwd, NPKILLRC_FILENAME), home ? join(home, NPKILLRC_FILENAME) : '']
      .find(p => p && existsSync(p))
  }
  if (!path)
    return {}

  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  }
  catch (e) {
    throw new CleanConfigError(`Invalid JSON in ${path}: ${(e as Error).message}`)
  }
  const error = validateNpkillrc(raw)
  if (error)
    throw new CleanConfigError(`Invalid config ${path}: ${error}`)
  return { config: raw as NpkillrcConfig, path }
}

export function getTargetsFromProfiles(names: string[], profiles: Record<string, CleanProfile>): string[] {
  const invalid = names.filter(name => !profiles[name])
  if (invalid.length) {
    throw new CleanConfigError(
      `Unknown profile(s): ${invalid.join(', ')}. Available: ${Object.keys(profiles).join(', ')}`,
    )
  }
  return [...new Set(names.flatMap(name => profiles[name].targets))]
}

export function resolveCleanConfig(
  dir: string | undefined,
  options: CleanCliOptions,
  { cwd = process.cwd(), home = getHomeDir() }: { cwd?: string, home?: string } = {},
): ResolvedClean {
  const config: CleanConfig = { ...DEFAULT_CLEAN_CONFIG, profiles: [...DEFAULT_CLEAN_CONFIG.profiles] }
  const { config: rc, path: configPath } = loadNpkillrc(options.config, cwd, home)

  // ---- .npkillrc ----
  let rootDir: string | undefined
  if (rc) {
    if (rc.rootDir)
      rootDir = rc.rootDir.replace(/^~(?=$|[/\\])/, home)
    if (rc.exclude)
      config.exclude.push(...rc.exclude)
    if (rc.sortBy)
      config.sortBy = rc.sortBy
    if (rc.sizeUnit)
      config.sizeUnit = rc.sizeUnit
    if (rc.excludeSensitiveResults !== undefined)
      config.excludeSensitiveResults = rc.excludeSensitiveResults
    if (rc.dryRun !== undefined)
      config.dryRun = rc.dryRun
    if (rc.defaultProfiles)
      config.profiles = rc.defaultProfiles
  }
  const profiles: Record<string, CleanProfile> = { ...DEFAULT_PROFILES, ...rc?.profiles }

  // ---- CLI ----
  if (dir || options.directory)
    rootDir = dir || options.directory
  else if (options.full)
    rootDir = home
  config.rootDir = resolve(cwd, rootDir ?? '.')

  const listProfiles = options.profiles === true || options.profiles === ''
  const cliTargets = splitList(options.targets)
  if (cliTargets.length) {
    config.targets = cliTargets
    config.profiles = []
  }
  else {
    const cliProfiles = splitList(options.profiles)
    if (cliProfiles.length)
      config.profiles = cliProfiles
    if (!listProfiles)
      config.targets = getTargetsFromProfiles(config.profiles, profiles)
  }

  config.exclude = [...new Set([...config.exclude, ...splitList(options.exclude)])]
  if (options.excludeSensitive)
    config.excludeSensitiveResults = true
  config.deleteAll = !!options.deleteAll
  config.yes = !!options.yes
  if (options.dryRun)
    config.dryRun = true
  config.json = !!options.json
  config.jsonStream = !!options.jsonStream
  if (config.json && config.jsonStream)
    throw new CleanConfigError('Cannot use both --json and --json-stream options simultaneously.')

  if (options.stats === false) {
    config.disableSize = true
    config.disableAge = true
  }
  if (options.size === false)
    config.disableSize = true
  if (options.age === false)
    config.disableAge = true

  if (options.olderThan !== undefined) {
    const days = Number(options.olderThan)
    if (!Number.isInteger(days) || days <= 0)
      throw new CleanConfigError('Invalid --older-than value. It must be a positive whole number of days (e.g. --older-than 90).')
    if (config.disableAge)
      throw new CleanConfigError('--older-than needs the age of each result, so it cannot be used with --no-age or --no-stats.')
    config.olderThan = days
  }

  if (options.sort !== undefined) {
    if (!CLEAN_SORT_CHOICES.includes(options.sort as CleanSortBy))
      throw new CleanConfigError(`Invalid sort option. Available: ${CLEAN_SORT_CHOICES.join(' | ')}`)
    config.sortBy = options.sort as CleanSortBy
  }
  if (options.sizeUnit !== undefined) {
    if (!CLEAN_SIZE_UNITS.includes(options.sizeUnit as CleanSizeUnit))
      throw new CleanConfigError(`Invalid size-unit option. Available: ${CLEAN_SIZE_UNITS.join(' | ')}`)
    config.sizeUnit = options.sizeUnit as CleanSizeUnit
  }
  config.hideErrors = !!options.hideErrors
  if (options.concurrency !== undefined) {
    const n = Number(options.concurrency)
    if (!Number.isInteger(n) || n <= 0)
      throw new CleanConfigError('Invalid --concurrency value. It must be a positive integer.')
    config.concurrency = n
  }

  return { config, profiles, listProfiles, configPath }
}
