import type { Dirent, Stats } from 'node:fs'
import { execFile } from 'node:child_process'
import { lstat, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'

/**
 * Directories never entered while scanning. If one of them is a target it's
 * still reported. Ported from npkill.
 */
const GLOBAL_IGNORE = new Set([
  // Version control
  '.git',
  '.svn',
  '.hg',
  '.fossil',
  // System folders
  '.Trash',
  '.Trashes',
  'System Volume Information',
  '.Spotlight-V100',
  '.fseventsd',
  // Tools and environments
  '.nvm',
  '.rvm',
  '.rustup',
  '.pyenv',
  '.rbenv',
  '.asdf',
  '.deno',
  // IDEs
  '.vscode',
  '.idea',
  '.vs',
  '.settings',
  // Other
  'snap',
  '.flatpak-info',
  // Heavy
  'node_modules',
  '__pycache__',
  'target',
  'build',
  'dist',
  '.cache',
  '.venv',
  'venv',
])

/** Ignored when looking for the newest file of a project (the "age"). */
const AGE_IGNORE = new Set(['node_modules', '.git', 'coverage', 'dist'])

/**
 * A small semaphore with an O(1) queue, used to bound how many targets get
 * their stats calculated at the same time.
 */
export class Limiter {
  private active = 0
  private queue: (() => void)[] = []
  private head = 0

  constructor(readonly concurrency: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency)
      await new Promise<void>(resolve => this.queue.push(resolve))
    this.active++
    try {
      return await fn()
    }
    finally {
      this.active--
      if (this.head < this.queue.length) {
        const next = this.queue[this.head++]
        if (this.head > 1024 && this.head * 2 > this.queue.length) {
          this.queue = this.queue.slice(this.head)
          this.head = 0
        }
        next()
      }
    }
  }
}

export interface AbortFlag {
  aborted: boolean
}

/**
 * Visits every directory under `root` with at most `concurrency` directories
 * being processed at once. `visit` receives the entries of a directory (or
 * `null` if it couldn't be read) and returns the subdirectories to descend
 * into. Uses an explicit stack, so huge trees don't build huge promise chains.
 */
function walkDirs(
  root: string,
  visit: (dir: string, entries: Dirent[] | null) => string[] | Promise<string[]>,
  { concurrency = 8, signal }: { concurrency?: number, signal?: AbortFlag } = {},
): Promise<void> {
  const stack = [root]
  let active = 0
  return new Promise((resolve) => {
    const pump = (): void => {
      while (active < concurrency && stack.length && !signal?.aborted) {
        const dir = stack.pop()!
        active++
        readdir(dir, { withFileTypes: true })
          .then(entries => visit(dir, entries), () => visit(dir, null))
          .then((subdirs) => {
            for (const sub of subdirs)
              stack.push(sub)
          }, () => {})
          .finally(() => {
            active--
            if (active === 0 && (stack.length === 0 || signal?.aborted))
              resolve()
            else
              pump()
          })
      }
    }
    pump()
  })
}

interface ScanProgress {
  /** Directories already read */
  scanned: number
  /** Directories queued and not read yet */
  pending: number
}

export interface ScanTargetsOptions {
  targets: Iterable<string>
  exclude?: string[]
  concurrency?: number
  signal?: AbortFlag
  onResult: (path: string) => void
  onProgress?: (progress: ScanProgress) => void
  onError?: (error: string) => void
}

function isExcluded(path: string, exclude: string[]): boolean {
  return exclude.some(ex => ex !== '' && path.includes(ex))
}

/**
 * Walks `rootDir` with bounded concurrency and reports every directory whose
 * name is one of `targets`, without descending into it. Symlinks are never
 * followed.
 */
export async function scanTargets(rootDir: string, options: ScanTargetsOptions): Promise<void> {
  const targets = new Set(options.targets)
  const exclude = options.exclude ?? []
  const signal = options.signal ?? { aborted: false }
  const progress: ScanProgress = { scanned: 0, pending: 1 }

  await walkDirs(rootDir, (dir, entries) => {
    progress.scanned++
    progress.pending--
    if (!entries) {
      options.onError?.(`Cannot read ${dir}`)
      options.onProgress?.(progress)
      return []
    }
    const subdirs: string[] = []
    for (const entry of entries) {
      if (signal.aborted)
        break
      if (!entry.isDirectory())
        continue
      const path = join(dir, entry.name)
      if (targets.has(entry.name)) {
        if (!isExcluded(path, exclude))
          options.onResult(path)
        continue
      }
      if (GLOBAL_IGNORE.has(entry.name) || isExcluded(path, exclude))
        continue
      subdirs.push(path)
    }
    progress.pending += subdirs.length
    options.onProgress?.(progress)
    return subdirs
  }, { concurrency: options.concurrency ?? 16, signal })
}

export interface WalkOptions {
  concurrency?: number
  signal?: AbortFlag
}

/**
 * Size on disk of a directory in bytes (like `du -s`): allocated blocks are
 * used when available and hard links are counted once.
 */
export async function getDirSize(dir: string, options: WalkOptions & { native?: boolean } = {}): Promise<number> {
  if (options.native !== false && process.platform !== 'win32') {
    const size = await duSize(dir)
    if (size !== null)
      return size
  }
  return getDirSizeJs(dir, options)
}

/**
 * `du -sk` is an order of magnitude faster than walking the tree from JS.
 * Returns `null` when `du` is unavailable or its output can't be parsed.
 */
function duSize(dir: string): Promise<number | null> {
  return new Promise((resolve) => {
    // `du` exits with 1 when some entries can't be read but still prints the
    // total of everything it could read, so the output is used regardless.
    execFile('du', ['-sk', dir], { maxBuffer: 1024 * 1024 }, (_error, stdout) => {
      const kb = Number.parseInt(String(stdout ?? '').trim().split(/\s/)[0], 10)
      resolve(Number.isFinite(kb) ? kb * 1024 : null)
    })
  })
}

/** Portable size calculation (used on Windows or when `du` isn't available). */
export async function getDirSizeJs(dir: string, options: WalkOptions = {}): Promise<number> {
  const useBlocks = process.platform !== 'win32'
  const seenInodes = new Set<string>()
  let total = 0

  const add = (stat: Stats): void => {
    if (stat.nlink > 1 && !stat.isDirectory()) {
      const key = `${stat.dev}:${stat.ino}`
      if (seenInodes.has(key))
        return
      seenInodes.add(key)
    }
    total += useBlocks && typeof stat.blocks === 'number' ? stat.blocks * 512 : stat.size
  }

  try {
    add(await lstat(dir))
  }
  catch {
    return 0
  }

  await walkDirs(dir, async (path, entries) => {
    if (!entries)
      return []
    const subdirs: string[] = []
    const stats: Promise<void>[] = []
    for (const entry of entries) {
      const child = join(path, entry.name)
      if (entry.isDirectory())
        subdirs.push(child)
      stats.push(lstat(child).then(add, () => {}))
    }
    await Promise.all(stats)
    return subdirs
  }, { concurrency: options.concurrency ?? 8, signal: options.signal })
  return total
}

/**
 * Newest modification time (ms) of any file inside `dir`, skipping
 * dependency/output directories. Returns `0` when nothing was found.
 */
export async function getNewestModification(dir: string, ignore: Iterable<string> = AGE_IGNORE, options: WalkOptions = {}): Promise<number> {
  const ignored = new Set([...ignore].map(i => i.toLowerCase()))
  let newest = 0

  await walkDirs(dir, async (path, entries) => {
    if (!entries)
      return []
    const subdirs: string[] = []
    const stats: Promise<void>[] = []
    for (const entry of entries) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name.toLowerCase()))
          subdirs.push(child)
      }
      else if (!entry.isSymbolicLink()) {
        stats.push(lstat(child).then((stat) => {
          if (stat.mtimeMs > newest)
            newest = stat.mtimeMs
        }, () => {}))
      }
    }
    await Promise.all(stats)
    return subdirs
  }, { concurrency: options.concurrency ?? 4, signal: options.signal })
  return newest
}

function rmrf(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('rm', ['-rf', path], error => error ? reject(error) : resolve())
  })
}

/**
 * Deletes a directory. On Unix an external `rm -rf` is used (fast and keeps the
 * event loop free for the UI); it falls back to `fs.rm` if that fails.
 */
export async function deleteDir(path: string): Promise<void> {
  if (process.platform !== 'win32') {
    try {
      await rmrf(path)
      return
    }
    catch {}
  }
  await rm(path, { recursive: true, force: true, maxRetries: 3 })
}

/** Simulates a deletion (used by `--dry-run`). */
export async function fakeDelete(maxDelay = 1500): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, maxDelay > 0 ? Math.floor(Math.random() * maxDelay) + 100 : 0))
}
