import type { CleanCliOptions, ResolvedClean } from './config'
import type { CleanStats } from './session'
import type { CleanConfig, CleanProfile, CleanResult } from './types'
import { statSync } from 'node:fs'
import { relative } from 'node:path'
import process from 'node:process'
import prompts from '@posva/prompts'
import c from 'ansis'
import { CleanConfigError, resolveCleanConfig } from './config'
import { formatSize, getAgeInDays, sortResults } from './format'
import { CleanSession } from './session'
import { CleanTui } from './tui'

const JSON_OUTPUT_VERSION = 1

interface JsonResult {
  path: string
  /** Bytes, `null` when not calculated */
  size: number | null
  /** Unix timestamp in seconds of the newest file of the project, `null` when unknown */
  modificationTime: number | null
  riskAnalysis: { isSensitive: boolean, reason?: string }
  status?: CleanResult['status']
}

function toJsonResult(result: CleanResult, withStatus = false): JsonResult {
  const json: JsonResult = {
    path: result.path,
    size: result.size,
    modificationTime: result.modificationTime ? Math.floor(result.modificationTime / 1000) : null,
    riskAnalysis: { isSensitive: result.riskAnalysis.isSensitive, reason: result.riskAnalysis.reason },
  }
  if (withStatus)
    json.status = result.status
  return json
}

export interface RunCleanIO {
  stdout?: NodeJS.WritableStream
  stderr?: NodeJS.WritableStream
  /** Force (or forbid) the full-screen UI. Defaults to stdin/stdout being TTYs */
  interactive?: boolean
  version?: string
  /** Upper bound of the simulated delay of `--dry-run` deletions */
  fakeDeleteDelay?: number
}

function formatProfiles(profiles: Record<string, CleanProfile>, defaults: string[]): string {
  const lines = [c.bold('Available profiles') + c.gray(' (use -p <name>[,<name>])'), '']
  for (const [name, profile] of Object.entries(profiles)) {
    const isDefault = defaults.includes(name)
    lines.push(`${c.green.bold(name)}${isDefault ? c.gray(' (default)') : ''}`)
    if (profile.description)
      lines.push(`  ${c.gray(profile.description)}`)
    lines.push(`  ${c.dim(profile.targets.join(', '))}`)
    lines.push('')
  }
  return lines.join('\n')
}

function exitMessage(stats: CleanStats, config: CleanConfig): string {
  const freed = formatSize(stats.releasedSize, config.sizeUnit)
  const title = c.bold.yellow('taze clean')
  if (!stats.deletedCount)
    return `${title} 👋 Nothing deleted.`
  const emoji = stats.releasedSize >= 50 * 1024 ** 3 ? '🤑' : '🚀'
  const dry = config.dryRun ? c.magenta(' (dry run)') : ''
  return `${title} ${emoji} Space released: ${c.green.bold(freed)}${c.gray(` (${stats.deletedCount} director${stats.deletedCount > 1 ? 'ies' : 'y'})`)}${dry}`
}

function formatResultLine(result: CleanResult, config: CleanConfig): string {
  const parts: string[] = []
  if (!config.disableSize)
    parts.push((result.size === null ? '-' : formatSize(result.size, config.sizeUnit)).padStart(9))
  if (!config.disableAge)
    parts.push((result.modificationTime ? `${getAgeInDays(result.modificationTime)}d` : '-').padStart(5))
  const rel = relative(config.rootDir, result.path) || result.path
  let path = rel.startsWith('..') ? result.path : rel
  if (result.riskAnalysis.isSensitive)
    path = `${c.yellowBright(path)} ${c.gray(`⚠ ${result.riskAnalysis.reason}`)}`
  const status = result.status === 'deleted'
    ? c.green(' [DELETED]')
    : result.status === 'error-deleting' ? c.red(` [ERROR] ${result.error ?? ''}`) : ''
  return `${parts.join(' ')}  ${path}${status}`
}

async function runJson(config: CleanConfig, io: Required<Pick<RunCleanIO, 'stdout' | 'stderr'>> & RunCleanIO): Promise<number> {
  const { stdout, stderr } = io
  const writeError = (message: string) => stderr.write(`${JSON.stringify({ version: JSON_OUTPUT_VERSION, error: true, message, timestamp: Date.now() })}\n`)
  if (config.deleteAll && !config.yes) {
    writeError('--delete-all with JSON output requires -y.')
    return 1
  }
  const session = new CleanSession(config, { fakeDeleteDelay: io.fakeDeleteDelay ?? 0 })
  const withStatus = config.deleteAll
  const emitted = new Set<CleanResult>()
  const isFinal = (r: CleanResult) => r.statsDone && (!withStatus || (r.status !== 'live' && r.status !== 'deleting'))

  if (config.jsonStream) {
    const flush = (result?: CleanResult) => {
      if (!result || emitted.has(result) || !isFinal(result) || !session.results.includes(result))
        return
      emitted.add(result)
      stdout.write(`${JSON.stringify({ version: JSON_OUTPUT_VERSION, result: toJsonResult(result, withStatus) })}\n`)
    }
    session.on((_event, result) => flush(result))
  }
  session.on((event) => {
    if (event === 'error' && !config.hideErrors)
      writeError(session.errors.at(-1)!)
  })

  let interrupted = false
  const writeSimple = () => {
    const results = sortResults(session.results, config.sortBy).map(r => toJsonResult(r, withStatus))
    stdout.write(`${JSON.stringify({
      version: JSON_OUTPUT_VERSION,
      results,
      meta: { resultsCount: results.length, runDuration: Date.now() - session.startedAt },
    }, null, 2)}\n`)
  }
  const onSignal = () => {
    interrupted = true
    session.stop()
    if (!config.jsonStream)
      writeSimple()
    process.exit(130)
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  try {
    await session.start()
    await waitForDeletions(session)
  }
  finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
  }
  if (!interrupted && !config.jsonStream)
    writeSimple()
  return session.results.some(r => r.status === 'error-deleting') ? 1 : 0
}

async function waitForDeletions(session: CleanSession): Promise<void> {
  if (session.pendingDeletions === 0)
    return
  await new Promise<void>((resolve) => {
    const off = session.on(() => {
      if (session.pendingDeletions === 0) {
        off()
        resolve()
      }
    })
  })
}

async function runPlain(config: CleanConfig, io: Required<Pick<RunCleanIO, 'stdout' | 'stderr'>> & RunCleanIO, canPrompt: boolean): Promise<number> {
  const { stdout, stderr } = io
  const out = (line = '') => stdout.write(`${line}\n`)

  // Scan first, delete afterwards, so the list can be confirmed.
  const deleteAll = config.deleteAll
  const session = new CleanSession({ ...config, deleteAll: false }, { fakeDeleteDelay: io.fakeDeleteDelay ?? 0 })
  await session.start()
  if (!config.hideErrors) {
    for (const error of session.errors)
      stderr.write(`${c.red(error)}\n`)
  }

  const results = sortResults(session.results, config.sortBy)
  if (!results.length) {
    out(`No ${c.yellow(config.targets.join(', '))} found in ${config.rootDir}`)
    return 0
  }
  for (const result of results)
    out(formatResultLine(result, config))
  out()
  const stats = session.getStats()
  out(`${c.bold(String(results.length))} director${results.length > 1 ? 'ies' : 'y'} found${config.disableSize ? '' : `, ${c.bold(formatSize(stats.totalSize, config.sizeUnit))} releasable`} ${c.gray(`(${(session.duration / 1000).toFixed(2)}s)`)}`)

  if (!deleteAll) {
    if (config.dryRun)
      out(c.magenta('Dry run: nothing was deleted.'))
    return 0
  }

  if (!config.yes) {
    if (!canPrompt) {
      stderr.write(`${c.red('--delete-all requires -y when not running in a terminal.')}\n`)
      return 1
    }
    const { confirmed } = await prompts({
      type: 'confirm',
      name: 'confirmed',
      message: `Delete ${results.length} director${results.length > 1 ? 'ies' : 'y'}${config.dryRun ? ' (dry run)' : ''}?`,
      initial: false,
    })
    if (!confirmed)
      return 1
  }

  await Promise.all(results.map(r => session.delete(r)))
  out()
  for (const result of results.filter(r => r.status !== 'deleted'))
    out(formatResultLine(result, config))
  out(exitMessage(session.getStats(), config))
  return results.some(r => r.status === 'error-deleting') ? 1 : 0
}

/** Entry point of `taze clean`. Returns the exit code. */
export async function runClean(dir: string | undefined, options: CleanCliOptions, io: RunCleanIO = {}): Promise<number> {
  const stdout = io.stdout ?? process.stdout
  const stderr = io.stderr ?? process.stderr

  let resolved: ResolvedClean
  try {
    resolved = resolveCleanConfig(dir, options)
  }
  catch (e) {
    if (e instanceof CleanConfigError) {
      stderr.write(`${c.red(e.message)}\n`)
      return 1
    }
    throw e
  }
  const { config, profiles, listProfiles } = resolved

  if (listProfiles) {
    stdout.write(`${formatProfiles(profiles, config.profiles)}\n`)
    return 0
  }

  try {
    if (!statSync(config.rootDir).isDirectory())
      throw new Error('not a directory')
  }
  catch {
    stderr.write(`${c.red(`Invalid directory: ${config.rootDir}`)}\n`)
    return 1
  }

  const fullIO = { ...io, stdout, stderr }
  if (config.json || config.jsonStream)
    return runJson(config, fullIO)

  const interactive = io.interactive ?? (!!process.stdout.isTTY && !!process.stdin.isTTY)
  if (!interactive)
    return runPlain(config, fullIO, false)

  const tui = new CleanTui(config, { version: io.version, profiles, fakeDeleteDelay: io.fakeDeleteDelay })
  const stats = await tui.start()
  stdout.write(`${exitMessage(stats, config)}\n`)
  return 0
}
