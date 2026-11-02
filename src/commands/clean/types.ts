export type CleanSortBy = 'none' | 'size' | 'path' | 'age'
export type CleanSizeUnit = 'auto' | 'mb' | 'gb'

export const CLEAN_SORT_CHOICES: CleanSortBy[] = ['none', 'size', 'path', 'age']
export const CLEAN_SIZE_UNITS: CleanSizeUnit[] = ['auto', 'mb', 'gb']

export interface CleanProfile {
  description?: string
  targets: string[]
}

export interface RiskAnalysis {
  isSensitive: boolean
  reason?: string
}

type CleanResultStatus = 'live' | 'deleting' | 'deleted' | 'error-deleting'

export interface CleanResult {
  /** Absolute path of the target directory */
  path: string
  /** Size on disk in bytes. `null` while it's being calculated or when disabled. */
  size: number | null
  /**
   * Newest modification time (ms since epoch) of the files in the project
   * that contains the target. `null` while unknown, `0` when it couldn't be
   * calculated.
   */
  modificationTime: number | null
  riskAnalysis: RiskAnalysis
  status: CleanResultStatus
  /** True once size and age (when enabled) are known */
  statsDone: boolean
  error?: string
}

export interface CleanConfig {
  /** Directory to start scanning from */
  rootDir: string
  /** Directory names to look for */
  targets: string[]
  /** Profiles used to build `targets` (informational) */
  profiles: string[]
  /** Path fragments to exclude from the scan */
  exclude: string[]
  excludeSensitiveResults: boolean
  deleteAll: boolean
  yes: boolean
  dryRun: boolean
  json: boolean
  jsonStream: boolean
  disableSize: boolean
  disableAge: boolean
  /** Only show results whose project wasn't modified in more than N days. 0 = disabled */
  olderThan: number
  sortBy: CleanSortBy
  sizeUnit: CleanSizeUnit
  hideErrors: boolean
  /** Max directories read concurrently while scanning */
  concurrency: number
}

export interface NpkillrcConfig {
  rootDir?: string
  exclude?: string[]
  sortBy?: CleanSortBy
  sizeUnit?: CleanSizeUnit
  excludeSensitiveResults?: boolean
  dryRun?: boolean
  checkUpdates?: boolean
  defaultProfiles?: string[]
  profiles?: Record<string, CleanProfile>
}
