import type { CleanConfig } from '../src/commands/clean'
import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { PassThrough } from 'node:stream'
import { stripVTControlCharacters } from 'node:util'
import { resolve } from 'pathe'
import { exec } from 'tinyexec'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { analyzeRisk, CleanSession, CleanTui, isSafeToDelete, resolveCleanConfig, runClean } from '../src/commands/clean'
import { CleanConfigError, DEFAULT_CLEAN_CONFIG } from '../src/commands/clean/config'
import { fitText, formatSize, isOlderThan, shortenMiddle, sortResults, textWidth } from '../src/commands/clean/format'
import { getDirSize, getDirSizeJs, getNewestModification, scanTargets } from '../src/commands/clean/fs'
import { DEFAULT_PROFILES } from '../src/commands/clean/profiles'

const binPath = resolve(__dirname, '../bin/taze.mjs')
const DAY = 86_400_000

let tmp: string

function write(rel: string, content: string | Buffer = 'x', mtime?: number) {
  const file = path.join(tmp, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
  if (mtime)
    fs.utimesSync(file, mtime / 1000, mtime / 1000)
  return file
}

function config(overrides: Partial<CleanConfig> = {}): CleanConfig {
  return { ...DEFAULT_CLEAN_CONFIG, rootDir: tmp, targets: ['node_modules'], ...overrides }
}

function collect(stream: PassThrough): () => string {
  let data = ''
  stream.on('data', chunk => data += chunk)
  return () => data
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'taze-clean-')))
  const old = Date.now() - 200 * DAY
  // project a: old, with a big node_modules and a nested one that must not be reported
  write('a/index.js', 'a', old)
  write('a/node_modules/big/file.bin', Buffer.alloc(300 * 1024))
  write('a/node_modules/big/node_modules/inner/index.js')
  write('a/.next/cache.json', '{}', old)
  // project b: fresh
  write('b/index.js', 'b')
  write('b/node_modules/pkg/index.js')
  // inside an ignored directory: never reached
  write('c/.git/node_modules/x.js')
  // excluded later
  write('vendor/lib/node_modules/y.js')
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('scanTargets', () => {
  it('stops at targets, skips ignored dirs and applies excludes', async () => {
    const found: string[] = []
    await scanTargets(tmp, { targets: ['node_modules', '.next'], exclude: ['vendor'], onResult: p => found.push(p) })
    expect(found.map(p => path.relative(tmp, p)).sort()).toEqual([
      path.join('a', '.next'),
      path.join('a', 'node_modules'),
      path.join('b', 'node_modules'),
    ])
  })

  it('reports progress and stops when aborted', async () => {
    const signal = { aborted: false }
    const found: string[] = []
    let progressCalls = 0
    await scanTargets(tmp, {
      targets: ['node_modules'],
      signal,
      onResult: (p) => {
        found.push(p)
        signal.aborted = true
      },
      onProgress: () => progressCalls++,
    })
    expect(found.length).toBeGreaterThanOrEqual(1)
    expect(found.length).toBeLessThan(3)
    expect(progressCalls).toBeGreaterThan(0)
  })
})

describe('stats', () => {
  it('calculates the size on disk', async () => {
    const dir = path.join(tmp, 'a/node_modules')
    const native = await getDirSize(dir)
    const js = await getDirSizeJs(dir)
    expect(native).toBeGreaterThanOrEqual(300 * 1024)
    expect(js).toBeGreaterThanOrEqual(300 * 1024)
    // Both methods should agree within a few blocks
    expect(Math.abs(native - js)).toBeLessThan(64 * 1024)
  })

  it('counts hard links once', async () => {
    const file = write('h/node_modules/a.bin', Buffer.alloc(200 * 1024))
    fs.linkSync(file, path.join(tmp, 'h/node_modules/b.bin'))
    const size = await getDirSizeJs(path.join(tmp, 'h/node_modules'))
    expect(size).toBeLessThan(400 * 1024)
  })

  it('finds the newest file of a project ignoring dependencies', async () => {
    const old = Date.now() - 200 * DAY
    const newest = await getNewestModification(path.join(tmp, 'a'))
    // node_modules contents are fresh but ignored, so the age is the old index.js
    expect(Math.abs(newest - old)).toBeLessThan(5000)
  })
})

describe('risk analysis', () => {
  const home = '/home/user'
  it.each([
    ['/home/user/projects/app/node_modules', false],
    ['/home/user/.npm/_npx/node_modules', false],
    ['/home/user/.config/app/node_modules', true],
    ['/home/user/.local/share/app/node_modules', true],
    ['/home/user/.cache/x/node_modules', true],
    ['/home/user/.vscode/extensions/x/node_modules', true],
    ['/home/user/projects/.hidden/node_modules', false],
    ['/Applications/Foo.app/Contents/node_modules', true],
    ['C:\\Users\\me\\AppData\\Roaming\\app\\node_modules', true],
    ['C:\\Users\\me\\AppData\\Local\\.cache\\node_modules', false],
    ['C:\\Program Files\\app\\node_modules', true],
  ])('%s → sensitive: %s', (p, sensitive) => {
    expect(analyzeRisk(p, home).isSensitive).toBe(sensitive)
  })

  it('only deletes target directories', () => {
    expect(isSafeToDelete('/a/b/node_modules', ['node_modules'])).toBe(true)
    expect(isSafeToDelete('/a/b/src', ['node_modules'])).toBe(false)
    expect(isSafeToDelete('/', ['node_modules'])).toBe(false)
  })
})

describe('format', () => {
  it('formats sizes like npkill', () => {
    expect(formatSize(5 * 1024 ** 2)).toBe('5 MB')
    expect(formatSize(1.5 * 1024 ** 3)).toBe('1.50 GB')
    expect(formatSize(5 * 1024 ** 2, 'gb')).toBe('0.00 GB')
    expect(formatSize(2 * 1024 ** 3, 'mb')).toBe('2048 MB')
  })

  it('checks ages', () => {
    const now = Date.now()
    expect(isOlderThan(now - 10 * DAY, 5, now)).toBe(true)
    expect(isOlderThan(now - 1 * DAY, 5, now)).toBe(false)
    expect(isOlderThan(null, 5, now)).toBe(false)
    expect(isOlderThan(0, 5, now)).toBe(false)
  })

  it('sorts results', () => {
    const base = { riskAnalysis: { isSensitive: false }, status: 'live' as const, statsDone: true }
    const results = [
      { ...base, path: '/b', size: 10, modificationTime: 300 },
      { ...base, path: '/a', size: 30, modificationTime: null },
      { ...base, path: '/c', size: 20, modificationTime: 100 },
    ]
    expect(sortResults(results, 'size').map(r => r.path)).toEqual(['/a', '/c', '/b'])
    expect(sortResults(results, 'path').map(r => r.path)).toEqual(['/a', '/b', '/c'])
    expect(sortResults(results, 'age').map(r => r.path)).toEqual(['/c', '/b', '/a'])
    expect(sortResults(results, 'none').map(r => r.path)).toEqual(['/b', '/a', '/c'])
  })

  it('fits text to the terminal width', () => {
    expect(textWidth('\u001B[31m项目\u001B[39m')).toBe(4)
    expect(stripVTControlCharacters(fitText('\u001B[31mhello world\u001B[39m', 5))).toBe('hello')
    expect(fitText('ab', 4)).toBe('ab  ')
    const short = shortenMiddle('some/very/long/path/to/node_modules', 20)
    expect(textWidth(short)).toBe(20)
    expect(short.endsWith('_modules')).toBe(true)
  })
})

describe('resolveCleanConfig', () => {
  const opts = () => ({ cwd: tmp, home: path.join(tmp, 'home') })

  it('uses the node profile by default', () => {
    const { config } = resolveCleanConfig(undefined, {}, opts())
    expect(config.rootDir).toBe(tmp)
    expect(config.profiles).toEqual(['node'])
    expect(config.targets).toEqual(DEFAULT_PROFILES.node.targets)
  })

  it('combines profiles and lets targets override them', () => {
    const { config } = resolveCleanConfig('a', { profiles: 'node,python' }, opts())
    expect(config.rootDir).toBe(path.join(tmp, 'a'))
    expect(config.targets).toContain('__pycache__')
    expect(config.targets).toContain('.next')

    const t = resolveCleanConfig(undefined, { targets: 'node_modules, .cache', profiles: 'python' }, opts())
    expect(t.config.targets).toEqual(['node_modules', '.cache'])
    expect(t.config.profiles).toEqual([])
  })

  it('lists profiles when -p has no value', () => {
    expect(resolveCleanConfig(undefined, { profiles: true }, opts()).listProfiles).toBe(true)
  })

  it('validates options', () => {
    expect(() => resolveCleanConfig(undefined, { profiles: 'nope' }, opts())).toThrow(CleanConfigError)
    expect(() => resolveCleanConfig(undefined, { json: true, jsonStream: true }, opts())).toThrow(/both/)
    expect(() => resolveCleanConfig(undefined, { olderThan: '-3' }, opts())).toThrow(/older-than/)
    expect(() => resolveCleanConfig(undefined, { olderThan: 3, age: false }, opts())).toThrow(/--no-age/)
    expect(() => resolveCleanConfig(undefined, { sort: 'weird' }, opts())).toThrow(/sort/)
    expect(() => resolveCleanConfig(undefined, { sizeUnit: 'tb' }, opts())).toThrow(/size-unit/)
  })

  it('maps --no-stats, --full, exclude and other flags', () => {
    const { config } = resolveCleanConfig(undefined, {
      stats: false,
      full: true,
      exclude: 'a,b',
      excludeSensitive: true,
      deleteAll: true,
      yes: true,
      dryRun: true,
      sort: 'size',
      sizeUnit: 'gb',
      olderThan: undefined,
    }, opts())
    expect(config.disableSize && config.disableAge).toBe(true)
    expect(config.rootDir).toBe(path.join(tmp, 'home'))
    expect(config.exclude).toEqual(['a', 'b'])
    expect(config).toMatchObject({ excludeSensitiveResults: true, deleteAll: true, yes: true, dryRun: true, sortBy: 'size', sizeUnit: 'gb' })
  })

  it('loads .npkillrc with custom profiles', () => {
    write('.npkillrc', JSON.stringify({
      exclude: ['vendor'],
      sortBy: 'path',
      dryRun: true,
      defaultProfiles: ['mine'],
      profiles: { mine: { description: 'custom', targets: ['.next'] } },
    }))
    const { config, configPath, profiles } = resolveCleanConfig(undefined, { exclude: 'other' }, opts())
    expect(configPath).toBe(path.join(tmp, '.npkillrc'))
    expect(config.targets).toEqual(['.next'])
    expect(config.exclude).toEqual(['vendor', 'other'])
    expect(config.sortBy).toBe('path')
    expect(config.dryRun).toBe(true)
    expect(profiles.mine.description).toBe('custom')
  })

  it('rejects invalid .npkillrc files', () => {
    write('bad.json', JSON.stringify({ sortBy: 'nope' }))
    expect(() => resolveCleanConfig(undefined, { config: 'bad.json' }, opts())).toThrow(/sortBy/)
    write('broken.json', '{')
    expect(() => resolveCleanConfig(undefined, { config: 'broken.json' }, opts())).toThrow(/Invalid JSON/)
    expect(() => resolveCleanConfig(undefined, { config: 'missing.json' }, opts())).toThrow(/not found/)
  })
})

describe('cleanSession', () => {
  it('finds results with stats', async () => {
    const session = new CleanSession(config({ exclude: ['vendor'] }), { home: path.join(tmp, 'home') })
    await session.start()
    expect(session.status).toBe('done')
    expect(session.results).toHaveLength(2)
    expect(session.results.every(r => r.statsDone && r.size !== null && r.size > 0)).toBe(true)
    const stats = session.getStats()
    expect(stats.totalSize).toBeGreaterThanOrEqual(300 * 1024)
    expect(stats.typeCounts).toEqual([{ type: 'node_modules', count: 2 }])
  })

  it('filters by age with olderThan', async () => {
    const session = new CleanSession(config({ olderThan: 100, exclude: ['vendor'] }))
    await session.start()
    expect(session.results.map(r => path.relative(tmp, r.path))).toEqual([path.join('a', 'node_modules')])
  })

  it('excludes sensitive results', async () => {
    write('home/.config/app/node_modules/x.js')
    const home = path.join(tmp, 'home')
    const all = new CleanSession(config({ rootDir: home }), { home })
    await all.start()
    expect(all.results).toHaveLength(1)
    expect(all.results[0].riskAnalysis).toMatchObject({ isSensitive: true })

    const filtered = new CleanSession(config({ rootDir: home, excludeSensitiveResults: true }), { home })
    await filtered.start()
    expect(filtered.results).toHaveLength(0)
  })

  it('dry run does not delete anything', async () => {
    const session = new CleanSession(config({ dryRun: true, deleteAll: true }), { fakeDeleteDelay: 0 })
    await session.start()
    expect(session.results.every(r => r.status === 'deleted')).toBe(true)
    expect(fs.existsSync(path.join(tmp, 'a/node_modules'))).toBe(true)
    expect(session.getStats().releasedSize).toBeGreaterThan(0)
  })

  it('deletes all results', async () => {
    const session = new CleanSession(config({ deleteAll: true, exclude: ['vendor'] }))
    await session.start()
    expect(session.pendingDeletions).toBe(0)
    expect(fs.existsSync(path.join(tmp, 'a/node_modules'))).toBe(false)
    expect(fs.existsSync(path.join(tmp, 'b/node_modules'))).toBe(false)
    expect(fs.existsSync(path.join(tmp, 'a/index.js'))).toBe(true)
    expect(fs.existsSync(path.join(tmp, 'vendor/lib/node_modules'))).toBe(true)
  })

  it('refuses to delete something that is not a target', async () => {
    const session = new CleanSession(config())
    const ok = await session.delete({ path: path.join(tmp, 'a'), size: 0, modificationTime: 0, riskAnalysis: { isSensitive: false }, status: 'live', statsDone: true })
    expect(ok).toBe(false)
    expect(session.errors[0]).toMatch(/not safe/)
    expect(fs.existsSync(path.join(tmp, 'a'))).toBe(true)
  })
})

describe('runClean (non interactive)', () => {
  function io() {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    return { stdout, stderr, out: collect(stdout), err: collect(stderr), interactive: false, fakeDeleteDelay: 0 }
  }

  it('outputs JSON', async () => {
    const o = io()
    expect(await runClean(tmp, { targets: 'node_modules', exclude: 'vendor', sort: 'path', json: true }, o)).toBe(0)
    const json = JSON.parse(o.out())
    expect(json.version).toBe(1)
    expect(json.meta.resultsCount).toBe(2)
    expect(json.results.map((r: any) => path.relative(tmp, r.path))).toEqual([path.join('a', 'node_modules'), path.join('b', 'node_modules')])
    expect(json.results[0].size).toBeGreaterThan(0)
    expect(json.results[0].modificationTime).toBeTypeOf('number')
  })

  it('outputs a JSON stream', async () => {
    const o = io()
    expect(await runClean(tmp, { targets: 'node_modules', exclude: 'vendor', jsonStream: true }, o)).toBe(0)
    const lines = o.out().trim().split('\n').map(l => JSON.parse(l))
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({ version: 1, result: { riskAnalysis: { isSensitive: false } } })
  })

  it('lists results and needs -y to delete without a terminal', async () => {
    const o = io()
    expect(await runClean(tmp, { targets: 'node_modules', deleteAll: true }, o)).toBe(1)
    expect(stripVTControlCharacters(o.out())).toContain(path.join('a', 'node_modules'))
    expect(o.err()).toContain('-y')
    expect(fs.existsSync(path.join(tmp, 'a/node_modules'))).toBe(true)
  })

  it('deletes with --delete-all -y and simulates with --dry-run', async () => {
    const dry = io()
    expect(await runClean(tmp, { targets: '.next', deleteAll: true, yes: true, dryRun: true }, dry)).toBe(0)
    expect(stripVTControlCharacters(dry.out())).toContain('dry run')
    expect(fs.existsSync(path.join(tmp, 'a/.next'))).toBe(true)

    const real = io()
    expect(await runClean(tmp, { targets: '.next', deleteAll: true, yes: true }, real)).toBe(0)
    expect(stripVTControlCharacters(real.out())).toContain('Space released')
    expect(fs.existsSync(path.join(tmp, 'a/.next'))).toBe(false)
  })

  it('reports config errors', async () => {
    const o = io()
    expect(await runClean(tmp, { profiles: 'nope' }, o)).toBe(1)
    expect(o.err()).toContain('Unknown profile')
    const missing = io()
    expect(await runClean(path.join(tmp, 'missing'), {}, missing)).toBe(1)
    expect(missing.err()).toContain('Invalid directory')
  })

  it('lists profiles', async () => {
    const o = io()
    expect(await runClean(tmp, { profiles: true }, o)).toBe(0)
    expect(stripVTControlCharacters(o.out())).toContain('node (default)')
  })
})

describe('cleanTui', () => {
  async function createTui(overrides: Partial<CleanConfig> = {}, size = { columns: 100, rows: 20 }) {
    const opened: string[] = []
    const tui = new CleanTui(config({ exclude: ['vendor'], sortBy: 'path', ...overrides }), {
      size,
      fakeDeleteDelay: 0,
      openFolder: p => opened.push(p),
      profiles: DEFAULT_PROFILES,
    })
    await tui.session.start()
    const screen = () => tui.renderFrame().map(l => stripVTControlCharacters(l))
    return { tui, screen, opened }
  }

  it('renders a full screen with header, results and footer', async () => {
    const { tui, screen } = await createTui()
    const lines = screen()
    expect(lines).toHaveLength(20)
    expect(lines.every(l => textWidth(l) <= 100)).toBe(true)
    expect(lines[0]).toContain('taze clean')
    expect(lines[1]).toContain('Search completed')
    expect(lines[3]).toContain('Releasable space')
    expect(lines[5]).toMatch(/Delete.*Age\s+Size/)
    expect(lines[6]).toContain(path.join('a', 'node_modules'))
    expect(lines[7]).toContain(path.join('b', 'node_modules'))
    expect(lines[6]).toMatch(/200d/)
    expect(lines[19]).toContain('quit')
    tui.dispose()
  })

  it('moves the cursor, pages and keeps it on the same result when re-sorting', async () => {
    const { tui } = await createTui()
    tui.handleKey({ name: 'down' })
    expect(tui.cursor).toBe(1)
    tui.handleKey({ name: 'down' })
    expect(tui.cursor).toBe(1)
    tui.handleKey({ name: 'home' })
    expect(tui.cursor).toBe(0)
    tui.handleKey({ name: 'end' })
    expect(tui.cursor).toBe(1)
    // b/node_modules is selected; sort by size puts a (bigger) first
    tui.handleKey({ name: 's' }) // age
    tui.handleKey({ name: 's' }) // none
    tui.handleKey({ name: 's' }) // size
    expect(tui.config.sortBy).toBe('size')
    tui.renderFrame()
    expect(tui.getViewResults()[tui.cursor].path).toBe(path.join(tmp, 'b/node_modules'))
    tui.dispose()
  })

  it('scrolls when there are more results than rows', async () => {
    for (let i = 0; i < 30; i++)
      write(`many/p${String(i).padStart(2, '0')}/node_modules/x.js`)
    const { tui, screen } = await createTui({ rootDir: path.join(tmp, 'many') }, { columns: 80, rows: 12 })
    expect(screen()[6]).toContain('p00')
    tui.handleKey({ name: 'pagedown' })
    tui.handleKey({ name: 'pagedown' })
    const lines = screen()
    expect(tui.scroll).toBeGreaterThan(0)
    expect(lines.some(l => l.includes(`p${String(tui.cursor).padStart(2, '0')}`))).toBe(true)
    expect(lines.slice(6, 11).some(l => l.endsWith('█'))).toBe(true)
    tui.dispose()
  })

  it('deletes the result under the cursor', async () => {
    const { tui, screen } = await createTui()
    tui.handleKey({ name: 'space' })
    await new Promise(r => setTimeout(r, 50))
    expect(fs.existsSync(path.join(tmp, 'a/node_modules'))).toBe(false)
    expect(screen()[6]).toContain('[DELETED]')
    expect(tui.getStats().deletedCount).toBe(1)
    tui.dispose()
  })

  it('multi-selects and deletes in batch (dry run)', async () => {
    const { tui, screen } = await createTui({ dryRun: true })
    tui.handleKey({ name: 't' })
    tui.handleKey({ name: 'a' })
    expect(tui.selected.size).toBe(2)
    expect(screen()[5]).toContain('2 selected')
    tui.handleKey({ name: 'return' })
    await new Promise(r => setTimeout(r, 50))
    expect(tui.session.results.every(r => r.status === 'deleted')).toBe(true)
    expect(fs.existsSync(path.join(tmp, 'a/node_modules'))).toBe(true)
    expect(screen()[0]).toContain('Dry run')
    tui.dispose()
  })

  it('selects ranges with v', async () => {
    for (let i = 0; i < 5; i++)
      write(`r/p${i}/node_modules/x.js`)
    const { tui } = await createTui({ rootDir: path.join(tmp, 'r') })
    tui.handleKey({ name: 't' })
    tui.handleKey({ name: 'down' })
    tui.handleKey({ name: 'v' })
    tui.handleKey({ name: 'down' })
    tui.handleKey({ name: 'down' })
    expect([...tui.selected].map(p => path.basename(path.dirname(p))).sort()).toEqual(['p1', 'p2', 'p3'])
    tui.dispose()
  })

  it('asks a second confirmation for sensitive results', async () => {
    write('home/.config/app/node_modules/x.js')
    const home = path.join(tmp, 'home')
    const tui = new CleanTui(config({ rootDir: home }), { size: { columns: 100, rows: 20 }, fakeDeleteDelay: 0 })
    tui.session = new CleanSession(tui.config, { home })
    await tui.session.start()
    expect(stripVTControlCharacters(tui.renderFrame()[6])).toContain('⚠')
    tui.handleKey({ name: 'space' })
    expect(tui.session.results[0].status).toBe('live')
    expect(stripVTControlCharacters(tui.message)).toContain('again')
    tui.handleKey({ name: 'space' })
    await new Promise(r => setTimeout(r, 50))
    expect(tui.session.results[0].status).toBe('deleted')
    tui.dispose()
  })

  it('searches with a regex', async () => {
    const { tui, screen } = await createTui()
    tui.handleKey({ sequence: '/', name: 'slash' })
    for (const ch of '^.*/b/')
      tui.handleKey({ sequence: ch, name: ch })
    tui.handleKey({ name: 'return' })
    expect(tui.getViewResults()).toHaveLength(1)
    expect(screen()[5]).toContain('Search: ^.*/b/')
    tui.handleKey({ name: 'escape' })
    expect(tui.getViewResults()).toHaveLength(2)
    tui.dispose()
  })

  it('switches between panels', async () => {
    const { tui, screen, opened } = await createTui()
    tui.handleKey({ name: 'right' })
    expect(tui.view).toBe('details')
    const details = screen().join('\n')
    expect(details).toContain('Holds all the Node packages')
    expect(details).toContain('Last modified')
    tui.handleKey({ name: 'o' })
    expect(opened).toEqual([path.join(tmp, 'a')])

    tui.handleKey({ name: 'left' })
    tui.handleKey({ name: 'left' })
    expect(tui.view).toBe('options')
    expect(screen().join('\n')).toContain('Sort by')
    tui.handleKey({ name: 'down' }) // Sort by
    tui.handleKey({ name: 'space' })
    expect(tui.config.sortBy).toBe('age')

    tui.handleKey({ name: 'left' })
    expect(tui.view).toBe('help')
    expect(screen().join('\n')).toContain('Navigation')

    tui.handleKey({ name: 'right' })
    tui.handleKey({ name: 'right' })
    expect(tui.view).toBe('list')
    tui.handleKey({ name: 'e' })
    expect(tui.view).toBe('errors')
    expect(screen().join('\n')).toContain('No errors')
    tui.handleKey({ name: 'escape' })
    expect(tui.view).toBe('list')
    tui.dispose()
  })

  it('restarts the scan when targets change in the options panel', async () => {
    const { tui } = await createTui()
    tui.view = 'options'
    tui.optionIndex = 6 // Targets
    tui.handleKey({ name: 'return' })
    expect(tui.editing).not.toBeNull()
    for (let i = 0; i < 40; i++)
      tui.handleKey({ name: 'backspace' })
    for (const ch of '.next')
      tui.handleKey({ sequence: ch, name: ch })
    tui.handleKey({ name: 'return' })
    expect(tui.config.targets).toEqual(['.next'])
    while (tui.session.status !== 'done')
      await new Promise(r => setTimeout(r, 10))
    expect(tui.session.results.map(r => path.basename(r.path))).toEqual(['.next'])
    tui.dispose()
  })

  it('shows the --delete-all warning until confirmed', async () => {
    const tui = new CleanTui(config({ deleteAll: true }), { size: { columns: 100, rows: 20 } })
    expect(tui.deleteAllWarning).toBe(true)
    expect(tui.renderFrame().join('\n')).toContain('--delete-all may have undesirable effects')
    tui.dispose()
  })

  it('takes over the terminal and restores it on quit', async () => {
    const input = new PassThrough() as unknown as NodeJS.ReadStream
    const output = new PassThrough() as unknown as NodeJS.WriteStream
    const out = collect(output as unknown as PassThrough)
    const tui = new CleanTui(config({ exclude: ['vendor'] }), { input, output, size: { columns: 80, rows: 15 }, fakeDeleteDelay: 0 })
    const done = tui.start()
    await new Promise(r => setTimeout(r, 150))
    ;(input as unknown as PassThrough).write('q')
    const stats = await done
    expect(stats.deletedCount).toBe(0)
    expect(out()).toContain('\u001B[?1049h')
    expect(out()).toContain('\u001B[?1049l')
    expect(stripVTControlCharacters(out())).toContain('node_modules')
  })

  it('handles tiny terminals', async () => {
    const { tui, screen } = await createTui({}, { columns: 30, rows: 5 })
    expect(screen()[0]).toContain('too small')
    tui.dispose()
  })
})

describe('cli', () => {
  it('exposes the clean command', async () => {
    const proc = await exec(process.execPath, [binPath, 'clean', tmp, '-t', 'node_modules', '-E', 'vendor', '--json'])
    expect(proc.exitCode).toBe(0)
    expect(JSON.parse(proc.stdout).meta.resultsCount).toBe(2)
  })

  it('shows clean in help', async () => {
    const proc = await exec(process.execPath, [binPath, 'clean', '--help'])
    expect(proc.stdout).toContain('--delete-all')
    expect(proc.stdout).toContain('--json-stream')
  })
})
