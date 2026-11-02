import type { AbortFlag } from './fs'
import type { CleanConfig, CleanResult } from './types'
import { basename, dirname, resolve } from 'node:path'
import { isOlderThan } from './format'
import { deleteDir, fakeDelete, getDirSize, getNewestModification, Limiter, scanTargets } from './fs'
import { analyzeRisk, getHomeDir, isSafeToDelete } from './risk'

export type CleanSessionStatus = 'idle' | 'scanning' | 'stats' | 'done'

export interface CleanSessionOptions {
  /** Upper bound of the random delay used by `--dry-run` deletions (ms) */
  fakeDeleteDelay?: number
  home?: string
}

export interface CleanStats {
  /** Bytes of every listed result (still present or deleted) */
  totalSize: number
  /** Bytes freed in this session */
  releasedSize: number
  deletedCount: number
  /** Count of results by directory name, most frequent first */
  typeCounts: { type: string, count: number }[]
}

/**
 * Drives a scan: finds targets, calculates their stats, deletes them and keeps
 * everything observable for the TUI and the non-interactive outputs.
 */
export class CleanSession {
  /** Accepted results, in discovery order */
  readonly results: CleanResult[] = []
  readonly errors: string[] = []
  status: CleanSessionStatus = 'idle'
  startedAt = 0
  /** Duration of the whole scan (including stats) in ms */
  duration = 0
  progress = { scanned: 0, pendingDirs: 0, found: 0, statsDone: 0 }
  pendingDeletions = 0

  private readonly signal: AbortFlag = { aborted: false }
  private readonly statsLimiter = new Limiter(8)
  private readonly listeners = new Set<(event: string, result?: CleanResult) => void>()
  private readonly home: string

  constructor(readonly config: CleanConfig, private readonly options: CleanSessionOptions = {}) {
    this.home = options.home ?? getHomeDir()
  }

  on(listener: (event: string, result?: CleanResult) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(event: string, result?: CleanResult): void {
    for (const listener of this.listeners)
      listener(event, result)
  }

  get aborted(): boolean {
    return this.signal.aborted
  }

  stop(): void {
    this.signal.aborted = true
  }

  private passesAgeFilter(result: CleanResult): boolean {
    return this.config.olderThan <= 0 || isOlderThan(result.modificationTime, this.config.olderThan)
  }

  private accept(result: CleanResult): void {
    this.results.push(result)
    this.emit('result', result)
  }

  async start(): Promise<void> {
    this.status = 'scanning'
    this.startedAt = Date.now()
    this.emit('status')
    const statsTasks: Promise<void>[] = []

    await scanTargets(this.config.rootDir, {
      targets: this.config.targets,
      exclude: this.config.exclude,
      concurrency: this.config.concurrency,
      signal: this.signal,
      onProgress: ({ scanned, pending }) => {
        this.progress.scanned = scanned
        this.progress.pendingDirs = pending
        this.emit('progress')
      },
      onError: error => this.addError(error),
      onResult: (path) => {
        const riskAnalysis = analyzeRisk(path, this.home)
        if (this.config.excludeSensitiveResults && riskAnalysis.isSensitive)
          return
        this.progress.found++
        const result: CleanResult = {
          path,
          size: null,
          modificationTime: null,
          riskAnalysis,
          status: 'live',
          statsDone: false,
        }
        // When filtering by age the result is only shown once its age is known.
        if (this.config.olderThan <= 0)
          this.accept(result)
        if (this.config.deleteAll && this.config.disableSize && this.config.olderThan <= 0)
          void this.delete(result)
        statsTasks.push(this.statsLimiter.run(() => this.calculateStats(result)))
      },
    })

    if (!this.signal.aborted) {
      this.status = 'stats'
      this.emit('status')
    }
    await Promise.all(statsTasks)
    this.duration = Date.now() - this.startedAt
    this.status = 'done'
    this.emit('status')
  }

  private async calculateStats(result: CleanResult): Promise<void> {
    if (this.signal.aborted)
      return
    const walkOptions = { signal: this.signal }
    const sizeTask = this.config.disableSize
      ? Promise.resolve(null)
      : getDirSize(result.path, walkOptions).catch(() => 0)

    const ageTask = (async () => {
      if (this.config.disableAge)
        return null
      const parent = dirname(result.path)
      // Targets directly inside HOME (e.g. ~/.npm) don't belong to a project.
      if (this.home && resolve(parent) === resolve(this.home))
        return 0
      return getNewestModification(parent, ['node_modules', '.git', 'coverage', 'dist', ...this.config.targets], walkOptions)
        .catch(() => 0)
    })()

    const [size, modificationTime] = await Promise.all([sizeTask, ageTask])
    result.size = size
    result.modificationTime = modificationTime
    result.statsDone = true
    this.progress.statsDone++

    const passes = this.passesAgeFilter(result)
    if (this.config.olderThan > 0 && passes)
      this.accept(result)
    this.emit('stats', result)

    if (this.config.deleteAll && passes && !(this.config.disableSize && this.config.olderThan <= 0))
      await this.delete(result)
  }

  addError(error: string): void {
    this.errors.push(error)
    this.emit('error')
  }

  /** Deletes (or simulates deleting, with `dryRun`) one result. */
  async delete(result: CleanResult): Promise<boolean> {
    if (result.status === 'deleted' || result.status === 'deleting')
      return false
    if (!isSafeToDelete(result.path, this.config.targets)) {
      this.addError(`Target not safe to delete: ${result.path}`)
      return false
    }

    result.status = 'deleting'
    this.pendingDeletions++
    this.emit('delete', result)
    try {
      if (this.config.dryRun)
        await fakeDelete(this.options.fakeDeleteDelay)
      else
        await deleteDir(result.path)
      result.status = 'deleted'
      return true
    }
    catch (e) {
      result.status = 'error-deleting'
      result.error = (e as Error).message
      this.addError(`Cannot delete ${result.path}: ${result.error}`)
      return false
    }
    finally {
      this.pendingDeletions--
      this.emit('delete', result)
    }
  }

  getStats(): CleanStats {
    let totalSize = 0
    let releasedSize = 0
    let deletedCount = 0
    const counts = new Map<string, number>()
    for (const result of this.results) {
      totalSize += result.size ?? 0
      if (result.status === 'deleted') {
        releasedSize += result.size ?? 0
        deletedCount++
      }
      const type = basename(result.path)
      counts.set(type, (counts.get(type) ?? 0) + 1)
    }
    const typeCounts = [...counts]
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type))
    return { totalSize, releasedSize, deletedCount, typeCounts }
  }
}
