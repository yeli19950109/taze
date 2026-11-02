import type { CleanStats } from './session'
import type { CleanConfig, CleanProfile, CleanResult, CleanSizeUnit, CleanSortBy } from './types'
import { spawn } from 'node:child_process'
import { basename, dirname, relative } from 'node:path'
import process from 'node:process'
import readline from 'node:readline'
import c from 'ansis'
import { getTargetsFromProfiles } from './config'
import { RESULT_TYPE_INFO } from './descriptions'
import { chunkText, fitText, formatSize, getAgeInDays, shortenMiddle, sortResults, textWidth, wrapText } from './format'
import { CleanSession } from './session'
import { CLEAN_SIZE_UNITS, CLEAN_SORT_CHOICES } from './types'

export type TuiView = 'help' | 'options' | 'list' | 'details' | 'errors'

/** Order of the tabs in the menu bar, navigable with ← / → */
const TABS: { view: TuiView, label: string }[] = [
  { view: 'help', label: 'Help' },
  { view: 'options', label: 'Options' },
  { view: 'list', label: 'Delete' },
  { view: 'details', label: 'Info' },
]

export interface TuiKey {
  name?: string
  sequence?: string
  ctrl?: boolean
  meta?: boolean
  shift?: boolean
}

export interface CleanTuiOptions {
  input?: NodeJS.ReadStream
  output?: NodeJS.WriteStream
  /** Fixed terminal size, mostly for tests */
  size?: { columns: number, rows: number }
  version?: string
  profiles?: Record<string, CleanProfile>
  fakeDeleteDelay?: number
  /** Don't actually open the file manager (tests) */
  openFolder?: (path: string) => void
}

const HEADER_ROWS = 6
const FOOTER_ROWS = 1
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const BAR_WIDTH = 25
const MIN_COLUMNS = 40
const MIN_ROWS = 10

const INFO = {
  DELETED: '[DELETED] ',
  DELETING: '[..deleting..] ',
  ERROR_DELETING: '[ ERROR ] ',
}

interface OptionItem {
  label: string
  type: 'checkbox' | 'dropdown' | 'input'
  get: () => string | boolean
  /** For checkbox / dropdown */
  toggle?: () => void
  /** For inputs */
  set?: (value: string) => void
}

const ESC = '\u001B['
const ALT_SCREEN_ON = '\u001B[?1049h'
const ALT_SCREEN_OFF = '\u001B[?1049l'
const CURSOR_HIDE = `${ESC}?25l`
const CURSOR_SHOW = `${ESC}?25h`
const CLEAR_SCREEN = `${ESC}2J${ESC}H`
const moveTo = (row: number) => `${ESC}${row + 1};1H`

function openFolderDefault(path: string): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open'
  const child = spawn(command, [path], { detached: true, stdio: 'ignore' })
  child.on('error', () => {})
  child.unref()
}

/**
 * Full-screen interactive UI for `taze clean`, modeled after npkill: results
 * are listed live as they're found, sizes and ages fill in as they're
 * calculated, and directories can be deleted one by one or in batches.
 */
export class CleanTui {
  session: CleanSession
  view: TuiView = 'list'
  cursor = 0
  scroll = 0
  selectMode = false
  readonly selected = new Set<string>()
  rangeStart: number | null = null
  searchText = ''
  searchInput = false
  message = ''
  /** Shown before scanning when `--delete-all` is used without `-y` */
  deleteAllWarning: boolean
  helpScroll = 0
  errorsScroll = 0
  optionIndex = 0
  editing: { index: number, value: string } | null = null

  private cursorPath: string | null = null
  private confirmSensitive: string | null = null
  private frame = 0
  private previousLines: string[] = []
  private renderTimer: NodeJS.Timeout | null = null
  private tickTimer: NodeJS.Timeout | null = null
  private messageTimer: NodeJS.Timeout | null = null
  private finish: ((stats: CleanStats) => void) | null = null
  private quitting = false
  private disposeInput = () => {}
  private readonly input: NodeJS.ReadStream
  private readonly output: NodeJS.WriteStream
  private readonly profiles: Record<string, CleanProfile>
  private readonly releasedBefore = { size: 0, count: 0 }

  constructor(readonly config: CleanConfig, private readonly options: CleanTuiOptions = {}) {
    this.input = options.input ?? process.stdin
    this.output = options.output ?? process.stdout
    this.profiles = options.profiles ?? {}
    this.deleteAllWarning = config.deleteAll && !config.yes
    this.session = this.createSession()
  }

  get columns(): number {
    return this.options.size?.columns ?? this.output.columns ?? 80
  }

  get rows(): number {
    return this.options.size?.rows ?? this.output.rows ?? 24
  }

  get bodyRows(): number {
    return Math.max(1, this.rows - HEADER_ROWS - FOOTER_ROWS)
  }

  private createSession(): CleanSession {
    const session = new CleanSession(this.config, { fakeDeleteDelay: this.options.fakeDeleteDelay })
    session.on(() => this.scheduleRender())
    return session
  }

  // ================= lifecycle =================

  /** Takes over the terminal. Resolves with the final stats once the user quits. */
  start(): Promise<CleanStats> {
    const promise = new Promise<CleanStats>((resolve) => {
      this.finish = resolve
    })
    this.output.write(ALT_SCREEN_ON + CURSOR_HIDE + CLEAR_SCREEN)
    this.registerInput()
    if (!this.deleteAllWarning)
      this.startScan()
    this.tickTimer = setInterval(() => this.tick(), 80)
    this.render()
    return promise
  }

  /** Starts (or restarts) scanning in the background. */
  startScan(): void {
    void this.session.start().catch(e => this.session.addError((e as Error).message))
  }

  private rescan(): void {
    const stats = this.session.getStats()
    this.releasedBefore.size += stats.releasedSize
    this.releasedBefore.count += stats.deletedCount
    this.session.stop()
    this.session = this.createSession()
    this.cursor = 0
    this.scroll = 0
    this.cursorPath = null
    this.selected.clear()
    this.startScan()
  }

  private registerInput(): void {
    const input = this.input
    readline.emitKeypressEvents(input)
    if (input.isTTY)
      input.setRawMode(true)
    input.resume()
    const onKey = (str: string | undefined, key: TuiKey | undefined) => this.handleKey(key ?? { name: str, sequence: str })
    const onResize = () => {
      this.previousLines = []
      this.output.write(CLEAR_SCREEN)
      this.render()
    }
    input.on('keypress', onKey)
    this.output.on('resize', onResize)
    this.disposeInput = () => {
      input.off('keypress', onKey)
      this.output.off('resize', onResize)
      if (input.isTTY)
        input.setRawMode(false)
      input.pause()
    }
  }

  private tick(): void {
    this.frame++
    if (this.session.status !== 'done' || this.session.pendingDeletions > 0)
      this.scheduleRender()
  }

  /** Final stats of every scan done in this run */
  getStats(): CleanStats {
    const stats = this.session.getStats()
    return {
      ...stats,
      releasedSize: stats.releasedSize + this.releasedBefore.size,
      deletedCount: stats.deletedCount + this.releasedBefore.count,
    }
  }

  async quit(force = false): Promise<void> {
    if (this.quitting && !force)
      return
    if (this.session.pendingDeletions > 0 && !force) {
      this.quitting = true
      this.setMessage(c.yellow(`Waiting for ${this.session.pendingDeletions} deletion(s) to finish... (ctrl+c to force quit)`), 0)
      await new Promise<void>((resolve) => {
        const off = this.session.on(() => {
          if (this.session.pendingDeletions === 0) {
            off()
            resolve()
          }
        })
      })
    }
    this.session.stop()
    this.dispose()
    this.finish?.(this.getStats())
  }

  dispose(): void {
    if (this.renderTimer)
      clearTimeout(this.renderTimer)
    if (this.tickTimer)
      clearInterval(this.tickTimer)
    if (this.messageTimer)
      clearTimeout(this.messageTimer)
    this.renderTimer = null
    this.tickTimer = null
    this.disposeInput()
    this.disposeInput = () => {}
    this.output.write(CURSOR_SHOW + ALT_SCREEN_OFF)
  }

  setMessage(message: string, timeout = 3000): void {
    this.message = message
    if (this.messageTimer)
      clearTimeout(this.messageTimer)
    if (timeout > 0) {
      this.messageTimer = setTimeout(() => {
        this.message = ''
        this.scheduleRender()
      }, timeout)
    }
    this.scheduleRender()
  }

  // ================= rendering =================

  scheduleRender(): void {
    if (this.renderTimer || !this.finish)
      return
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null
      this.render()
    }, 30)
  }

  /** Writes only the lines that changed since the previous frame. */
  render(): void {
    if (!this.finish)
      return
    const lines = this.renderFrame()
    let out = ''
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] !== this.previousLines[i])
        out += moveTo(i) + lines[i]
    }
    this.previousLines = lines
    if (out)
      this.output.write(out)
  }

  /** Visible results: filtered by the search and sorted. */
  getViewResults(): CleanResult[] {
    let results = this.session.results
    if (this.config.excludeSensitiveResults)
      results = results.filter(r => !r.riskAnalysis.isSensitive)
    if (this.searchText) {
      let regex: RegExp
      try {
        regex = new RegExp(this.searchText, 'i')
      }
      catch {
        return []
      }
      results = results.filter(r => regex.test(r.path))
    }
    return sortResults(results, this.config.sortBy)
  }

  /** Keeps the cursor on the same result when the list is re-sorted. */
  private syncCursor(view: CleanResult[]): void {
    if (this.cursorPath) {
      const index = view.findIndex(r => r.path === this.cursorPath)
      if (index !== -1)
        this.cursor = index
    }
    this.cursor = Math.max(0, Math.min(this.cursor, view.length - 1))
    this.cursorPath = view[this.cursor]?.path ?? null
    this.fitScroll(view.length)
  }

  private fitScroll(total: number): void {
    const rows = this.bodyRows
    if (this.cursor < this.scroll)
      this.scroll = this.cursor
    else if (this.cursor >= this.scroll + rows)
      this.scroll = this.cursor - rows + 1
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, total - rows)))
  }

  /** Builds the whole screen as an array of exactly `rows` lines. */
  renderFrame(): string[] {
    const { columns, rows } = this
    if (columns < MIN_COLUMNS || rows < MIN_ROWS) {
      const lines = Array.from({ length: rows }, () => ' '.repeat(columns))
      lines[0] = fitText(c.yellow('Terminal too small, please enlarge it.'), columns)
      return lines
    }

    const view = this.getViewResults()
    this.syncCursor(view)

    const body = this.renderBody(view).slice(0, this.bodyRows)
    while (body.length < this.bodyRows)
      body.push('')
    const lines = [...this.renderHeader(view), ...body, this.renderFooter()]
    return lines.slice(0, rows).map((line, i) => fitText(line, i === rows - 1 ? columns - 1 : columns))
  }

  private renderHeader(view: CleanResult[]): string[] {
    const { columns } = this
    const session = this.session
    const stats = this.getStats()

    // Row 0: title
    let title = `${c.bgYellow.black.bold(' taze clean ')} ${c.gray(this.config.rootDir)}`
    if (this.config.dryRun)
      title += ` ${c.bgMagenta.black(' Dry run mode ')}`
    if (this.options.version)
      title += c.gray(`  v${this.options.version}`)

    // Row 1: status
    const spinner = SPINNER[this.frame % SPINNER.length]
    let status: string
    if (this.deleteAllWarning)
      status = c.yellow('Waiting for confirmation')
    else if (session.status === 'scanning' || session.status === 'idle')
      status = `Searching ${spinner} ${c.gray(`${session.progress.scanned} dirs scanned`)}`
    else if (session.status === 'stats')
      status = `Calculating stats ${spinner} ${c.gray(`${session.progress.statsDone}/${session.progress.found}`)}`
    else
      status = c.green('Search completed ') + c.gray(`${(session.duration / 1000).toFixed(2)}s`)
    if (session.pendingDeletions > 0)
      status += `  ${c.yellow(`${session.pendingDeletions} pending task${session.pendingDeletions > 1 ? 's' : ''}`)}`

    // Row 2: progress bar (done stats / scanned dirs / pending dirs)
    let bar = ''
    if (session.status !== 'done' && !this.deleteAllWarning) {
      const { scanned, pendingDirs, found, statsDone } = session.progress
      const totalDirs = scanned + pendingDirs
      const searched = totalDirs ? Math.round(BAR_WIDTH * scanned / totalDirs) : 0
      const done = found ? Math.round(searched * statsDone / found) : 0
      bar = c.green('▀'.repeat(done)) + c.white('▀'.repeat(searched - done)) + c.gray('▀'.repeat(BAR_WIDTH - searched))
    }

    // Row 3: space stats
    const parts: string[] = []
    if (!this.config.disableSize) {
      parts.push(`${c.gray('Releasable space:')} ${formatSize(stats.totalSize, this.config.sizeUnit)}`)
      parts.push(`${c.gray('Space saved:')} ${c.green(formatSize(stats.releasedSize, this.config.sizeUnit))}`)
    }
    parts.push(`${c.gray('Results:')} ${view.length}${view.length !== session.results.length ? c.gray(`/${session.results.length}`) : ''}`)
    if (session.errors.length && !this.config.hideErrors)
      parts.push(c.red(`${session.errors.length} error${session.errors.length > 1 ? 's' : ''} (press e)`))

    // Row 4: type counts or transient message
    const typeLine = this.message || c.gray(stats.typeCounts.slice(0, 8).map(t => `${t.type} ${c.white(String(t.count))}`).join(c.gray(' · ')))

    return [
      title,
      ` ${status}`,
      ` ${bar}`,
      ` ${parts.join('   ')}`,
      ` ${typeLine}`,
      this.renderMenuBar(columns),
    ]
  }

  private renderMenuBar(columns: number): string {
    const bg = (text: string) => c.bgYellow.black(text)
    let left: string
    if (this.searchInput || this.searchText) {
      const text = ` Search: ${this.searchText}${this.searchInput ? '_' : ''} `
      left = this.searchInput ? c.bgBlue.white(text) : c.bgWhite.black(text)
    }
    else {
      left = TABS.map(tab => tab.view === this.view
        ? c.bgYellow.black.bold.underline(` ${tab.label} `)
        : c.bgYellow.gray(` ${tab.label} `)).join('')
    }
    if (this.selectMode)
      left += ` ${c.bgBlack.yellow(` ${this.selected.size} selected `)}`

    let right = ''
    if (this.view === 'list') {
      const headers = [this.config.disableAge ? '' : ' Age', this.config.disableSize ? '' : '     Size']
      right = headers.join('')
      if (this.config.sortBy !== 'none' && !this.searchInput && !this.searchText)
        left += c.bgYellow.gray(` sorted by ${this.config.sortBy} `)
    }
    const fill = Math.max(0, columns - textWidth(left) - textWidth(right) - 2)
    return ` ${left}${bg(' '.repeat(fill))}${right ? bg(right) : ''} `
  }

  private renderFooter(): string {
    const k = (key: string, desc: string) => `${c.bold.green(key)} ${c.gray(desc)}`
    const hints: Record<TuiView, string[]> = {
      list: this.selectMode
        ? [k('space', 'toggle'), k('v', 'range'), k('a', 'all'), k('enter', 'delete selected'), k('t', 'exit select')]
        : [k('↑↓', 'move'), k('space', 'delete'), k('t', 'multi-select'), k('/', 'search'), k('s', 'sort'), k('o', 'open'), k('←→', 'panels'), k('q', 'quit')],
      details: [k('←', 'back'), k('space', 'delete'), k('o', 'open folder'), k('q', 'back')],
      options: this.editing
        ? [k('enter', 'apply'), k('esc', 'cancel')]
        : [k('↑↓', 'move'), k('space/enter', 'change'), k('→', 'back to results')],
      help: [k('↑↓', 'scroll'), k('→', 'options'), k('q', 'back')],
      errors: [k('↑↓', 'scroll'), k('esc/q', 'back')],
    }
    if (this.deleteAllWarning)
      return ` ${k('y', 'continue')}  ${k('any key', 'quit')}`
    return ` ${hints[this.view].join('  ')}`
  }

  private renderBody(view: CleanResult[]): string[] {
    if (this.deleteAllWarning)
      return this.renderDeleteAllWarning()
    switch (this.view) {
      case 'list':
        return this.renderList(view)
      case 'details':
        return this.renderDetails(view[this.cursor])
      case 'options':
        return this.renderOptions()
      case 'help':
        return this.renderScrollable(this.getHelpLines(), 'helpScroll')
      case 'errors':
        return this.renderScrollable(this.session.errors.length
          ? this.session.errors.map(e => c.red(` ${e}`))
          : [c.gray(' No errors.')], 'errorsScroll')
    }
  }

  private renderDeleteAllWarning(): string[] {
    return [
      '',
      c.yellow.bold('    --delete-all may have undesirable effects and'),
      c.yellow.bold('    delete dependencies needed by some applications.'),
      c.yellow.bold('    Recommended to use -x and preview with --dry-run.'),
      '',
      `                 Press ${c.bold('y')} to continue.`,
      '',
      c.gray('           pass -y to not show this next time'),
    ]
  }

  private renderList(view: CleanResult[]): string[] {
    const { columns } = this
    const rows = this.bodyRows
    const lines: string[] = []

    if (view.length === 0) {
      let message: string
      if (this.session.status !== 'done')
        message = c.gray('Searching...')
      else if (this.searchText)
        message = `No results match ${c.yellow(this.searchText)}`
      else
        message = `No ${c.yellowBright(this.config.targets.join(', '))} found!`
      const pad = Math.max(0, Math.floor((columns - textWidth(message)) / 2))
      return ['', '', `${' '.repeat(pad)}${message}`]
    }

    const ageWidth = this.config.disableAge ? 0 : 4
    const sizeWidth = this.config.disableSize ? 0 : 9
    const columnsWidth = ageWidth + sizeWidth
    // 1 marker + path + 2 gap + columns + 1 scrollbar
    const pathWidth = Math.max(10, columns - 1 - 2 - columnsWidth - 1)
    const visible = view.slice(this.scroll, this.scroll + rows)
    const showScrollbar = view.length > rows
    const thumb = showScrollbar
      ? Math.round(this.scroll / (view.length - rows) * (rows - 1))
      : -1

    visible.forEach((result, i) => {
      const index = this.scroll + i
      const isCursor = index === this.cursor && !this.searchInput
      const isSelected = this.selected.has(result.path)

      let prefix = ''
      let prefixColor = (s: string) => s
      if (result.status === 'deleted') {
        prefix = INFO.DELETED
        prefixColor = c.green
      }
      else if (result.status === 'deleting') {
        prefix = INFO.DELETING
        prefixColor = c.yellow
      }
      else if (result.status === 'error-deleting') {
        prefix = INFO.ERROR_DELETING
        prefixColor = c.red
      }
      const warning = result.riskAnalysis.isSensitive ? ' ⚠️' : ''
      const rel = this.displayPath(result.path)
      const pathText = shortenMiddle(rel, pathWidth - prefix.length - textWidth(warning))
      let pathCell = prefixColor(prefix) + pathText + warning
      if (result.riskAnalysis.isSensitive)
        pathCell = (isSelected ? c.blue : c.yellowBright)(pathCell)
      else if (isSelected)
        pathCell = c.blue(pathCell)
      pathCell = fitText(pathCell, pathWidth)

      let age = ''
      if (ageWidth) {
        let text: string
        if (!result.statsDone)
          text = '...'
        else if (!result.modificationTime)
          text = '-'
        else
          text = `${Math.min(getAgeInDays(result.modificationTime), 999)}d`
        age = text.padStart(ageWidth)
        age = isCursor ? age : c.gray(age)
      }
      let size = ''
      if (sizeWidth) {
        size = result.size === null
          ? c.gray('.....'.padStart(sizeWidth - 1).padEnd(sizeWidth))
          : formatSize(result.size, this.config.sizeUnit).padStart(sizeWidth - 1).padEnd(sizeWidth)
      }

      const marker = this.selectMode
        ? (isSelected ? c.blue('●') : (this.rangeStart !== null && isCursor ? c.yellow('○') : ' '))
        : ' '
      let row = `${pathCell}  ${age}${size}`
      if (isCursor)
        row = c.bgBlue(fitText(row, pathWidth + 2 + columnsWidth))
      const scrollbar = showScrollbar ? (i === thumb ? c.gray('█') : c.gray('┊')) : ' '
      lines.push(marker + row + scrollbar)
    })

    if (showScrollbar) {
      for (let i = visible.length; i < rows; i++)
        lines.push(`${' '.repeat(columns - 1)}${i === thumb ? c.gray('█') : c.gray('┊')}`)
    }
    return lines
  }

  displayPath(path: string): string {
    const rel = relative(this.config.rootDir, path)
    return rel && !rel.startsWith('..') ? rel : path
  }

  private renderDetails(result: CleanResult | undefined): string[] {
    if (!result)
      return ['', c.gray(' No result selected.')]
    const width = Math.min(this.columns - 2, 80)
    const label = (text: string) => c.gray(text.padEnd(14))
    const lines: string[] = ['']
    const type = basename(result.path)
    lines.push(` ${c.bold.yellow(type)}`)
    lines.push('')
    for (const [i, chunk] of chunkText(result.path, width - 15).entries())
      lines.push(` ${i === 0 ? label('Path') : ' '.repeat(14)}${chunk}`)
    lines.push(` ${label('Parent')}${shortenMiddle(dirname(result.path), width - 15)}`)
    if (!this.config.disableSize)
      lines.push(` ${label('Size')}${result.size === null ? c.gray('calculating...') : formatSize(result.size, this.config.sizeUnit)}`)
    if (!this.config.disableAge) {
      let age: string
      if (!result.statsDone)
        age = c.gray('calculating...')
      else if (!result.modificationTime)
        age = c.gray('unknown')
      else
        age = `${getAgeInDays(result.modificationTime)} days ago ${c.gray(`(${new Date(result.modificationTime).toLocaleString()})`)}`
      lines.push(` ${label('Last modified')}${age}`)
    }
    const statusText: Record<CleanResult['status'], string> = {
      'live': 'Present',
      'deleting': c.yellow('Deleting...'),
      'deleted': c.green('Deleted'),
      'error-deleting': c.red(`Error: ${result.error ?? 'unknown'}`),
    }
    lines.push(` ${label('Status')}${statusText[result.status]}`)
    if (result.riskAnalysis.isSensitive)
      lines.push(` ${label('Sensitive')}${c.yellowBright(`⚠️  ${result.riskAnalysis.reason ?? 'yes'}`)}`)
    const description = RESULT_TYPE_INFO[type.toLowerCase()]
    if (description) {
      lines.push('')
      for (const line of wrapText(description, width - 2))
        lines.push(` ${c.gray(line)}`)
    }
    return lines
  }

  private getOptionItems(): OptionItem[] {
    const cycle = <T>(list: T[], value: T) => list[(list.indexOf(value) + 1) % list.length]
    return [
      {
        label: 'Sensitive results',
        type: 'checkbox',
        get: () => !this.config.excludeSensitiveResults,
        toggle: () => {
          this.config.excludeSensitiveResults = !this.config.excludeSensitiveResults
        },
      },
      {
        label: 'Sort by',
        type: 'dropdown',
        get: () => this.config.sortBy,
        toggle: () => {
          this.config.sortBy = cycle<CleanSortBy>(CLEAN_SORT_CHOICES, this.config.sortBy)
        },
      },
      {
        label: 'Size unit',
        type: 'dropdown',
        get: () => this.config.sizeUnit,
        toggle: () => {
          this.config.sizeUnit = cycle<CleanSizeUnit>(CLEAN_SIZE_UNITS, this.config.sizeUnit)
        },
      },
      {
        label: 'Dry-run',
        type: 'checkbox',
        get: () => this.config.dryRun,
        toggle: () => {
          this.config.dryRun = !this.config.dryRun
        },
      },
      {
        label: 'Exclude',
        type: 'input',
        get: () => this.config.exclude.join(','),
        set: (value) => {
          this.config.exclude = value.split(',').map(v => v.trim()).filter(Boolean)
          this.rescan()
        },
      },
      {
        label: 'Profiles',
        type: 'input',
        get: () => this.config.profiles.join(','),
        set: (value) => {
          const names = value.split(',').map(v => v.trim()).filter(Boolean)
          try {
            this.config.targets = getTargetsFromProfiles(names, this.profiles)
            this.config.profiles = names
            this.rescan()
          }
          catch (e) {
            this.setMessage(c.red((e as Error).message))
          }
        },
      },
      {
        label: 'Targets',
        type: 'input',
        get: () => this.config.targets.join(','),
        set: (value) => {
          const targets = value.split(',').map(v => v.trim()).filter(Boolean)
          if (!targets.length)
            return this.setMessage(c.red('At least one target is required.'))
          this.config.targets = targets
          this.config.profiles = []
          this.rescan()
        },
      },
      {
        label: 'Cwd',
        type: 'input',
        get: () => this.config.rootDir,
        set: (value) => {
          if (!value.trim())
            return
          this.config.rootDir = value.trim()
          this.rescan()
        },
      },
    ]
  }

  private renderOptions(): string[] {
    const items = this.getOptionItems()
    const lines = ['', ` ${c.bold('Options')} ${c.gray('(changing exclude / profiles / targets / cwd restarts the scan)')}`, '']
    items.forEach((item, i) => {
      const active = i === this.optionIndex
      const pointer = active ? c.cyan('❯ ') : '  '
      let value: string
      if (this.editing?.index === i)
        value = c.bgBlue.white(` ${this.editing.value}_ `)
      else if (item.type === 'checkbox')
        value = item.get() ? c.green('[x]') : c.gray('[ ]')
      else if (item.type === 'dropdown')
        value = `${c.cyan(`< ${item.get()} >`)}`
      else
        value = c.white(String(item.get()) || c.gray('(empty)'))
      lines.push(` ${pointer}${(active ? c.bold : c.gray)(item.label.padEnd(20))}${value}`)
    })
    return lines
  }

  private renderScrollable(lines: string[], key: 'helpScroll' | 'errorsScroll'): string[] {
    const rows = this.bodyRows
    this[key] = Math.max(0, Math.min(this[key], Math.max(0, lines.length - rows)))
    return lines.slice(this[key], this[key] + rows)
  }

  getHelpLines(): string[] {
    const h = (title: string) => c.bgYellow.black.bold(` ${title} `)
    const k = (key: string, desc: string) => `  ${c.green(key.padEnd(24))}${desc}`
    const width = Math.min(this.columns - 4, 90)
    return [
      '',
      ...wrapText('taze clean finds "junk" directories left behind by development tools (node_modules, caches, build outputs...). They are essential while you work on a project, but pile up and eat disk space long after you moved on. It lists them with their size and how long ago you last touched each project, so you can decide what to keep and what to clean.', width).map(l => ` ${l}`),
      '',
      h('Navigation'),
      k('↑ / k, ↓ / j', 'Move cursor'),
      k('← / h, → / l', 'Switch panels (Help · Options · Delete · Info)'),
      k('PgUp / u, PgDown / d', 'Move one page up / down'),
      k('Home / g, End / G', 'Jump to first / last result'),
      '',
      h('Actions'),
      k('SPACE / DEL', 'Delete the result under the cursor'),
      k('o', 'Open the parent directory'),
      k('/', 'Search (regex supported), ESC to clear'),
      k('s', 'Cycle sort order (none, size, path, age)'),
      k('t', 'Enter / leave multi-select mode'),
      k('e', 'Show errors'),
      k('q / ESC', 'Quit'),
      '',
      h('Multi-select mode'),
      k('SPACE', 'Select / deselect current'),
      k('v', 'Range selection'),
      k('a', 'Select / deselect all'),
      k('ENTER', 'Delete selected directories'),
      '',
      h('Header information'),
      ...wrapText('Releasable space is the size of every directory found: the maximum you could free. Space saved is what was actually freed in this session. While scanning, the progress bar shows results with stats ready (green), directories examined (white) and directories pending (gray).', width).map(l => ` ${l}`),
      '',
      h('Important note'),
      ...wrapText('Not all results are bad! Some applications (VS Code, Discord...) need their dependencies to work. Results that look like they belong to an application are highlighted with ⚠️ and require a second confirmation before being deleted. Use -x to hide them.', width).map(l => ` ${l}`),
    ]
  }

  // ================= input =================

  handleKey(key: TuiKey): void {
    if (key.ctrl && key.name === 'c') {
      void this.quit(this.quitting)
      return
    }
    if (this.quitting)
      return

    if (this.deleteAllWarning) {
      if (key.name === 'y') {
        this.deleteAllWarning = false
        this.startScan()
      }
      else {
        void this.quit()
      }
      this.scheduleRender()
      return
    }

    if (this.searchInput)
      this.handleSearchKey(key)
    else if (this.editing)
      this.handleEditKey(key)
    else
      this.handleViewKey(key)
    this.scheduleRender()
  }

  private handleSearchKey(key: TuiKey): void {
    if (key.name === 'return' || key.name === 'enter') {
      this.searchInput = false
      if (!this.searchText.trim())
        this.searchText = ''
    }
    else if (key.name === 'escape') {
      this.searchInput = false
      this.searchText = ''
    }
    else if (key.name === 'backspace') {
      this.searchText = this.searchText.slice(0, -1)
    }
    else if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta && key.sequence >= ' ') {
      this.searchText += key.sequence
      this.cursor = 0
      this.cursorPath = null
      this.scroll = 0
    }
  }

  private handleEditKey(key: TuiKey): void {
    const editing = this.editing!
    if (key.name === 'return' || key.name === 'enter') {
      this.editing = null
      this.getOptionItems()[editing.index].set?.(editing.value)
    }
    else if (key.name === 'escape') {
      this.editing = null
    }
    else if (key.name === 'backspace') {
      editing.value = editing.value.slice(0, -1)
    }
    else if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta && key.sequence >= ' ') {
      editing.value += key.sequence
    }
  }

  private switchTab(direction: -1 | 1): void {
    const index = TABS.findIndex(t => t.view === this.view)
    const next = TABS[index + direction]
    if (!next)
      return
    if (next.view === 'details' && !this.getViewResults().length)
      return
    this.view = next.view
  }

  private handleViewKey(key: TuiKey): void {
    const name = key.name
    if (name === 'left' || name === 'h') {
      if (this.view === 'errors')
        this.view = 'list'
      else if (!this.searchText)
        this.switchTab(-1)
      return
    }
    if (name === 'right' || name === 'l') {
      if (this.view === 'errors')
        this.view = 'list'
      else
        this.switchTab(1)
      return
    }

    switch (this.view) {
      case 'list':
        return this.handleListKey(key)
      case 'details':
        return this.handleDetailsKey(key)
      case 'options':
        return this.handleOptionsKey(key)
      case 'help':
      case 'errors': {
        const prop = this.view === 'help' ? 'helpScroll' : 'errorsScroll'
        if (name === 'up' || name === 'k')
          this[prop]--
        else if (name === 'down' || name === 'j')
          this[prop]++
        else if (name === 'pageup' || name === 'u')
          this[prop] -= this.bodyRows - 1
        else if (name === 'pagedown' || name === 'd')
          this[prop] += this.bodyRows - 1
        else if (name === 'q' || name === 'escape')
          this.view = 'list'
        this[prop] = Math.max(0, this[prop])
      }
    }
  }

  private moveCursor(delta: number): void {
    const view = this.getViewResults()
    if (!view.length)
      return
    this.cursor = Math.max(0, Math.min(view.length - 1, this.cursor + delta))
    this.cursorPath = view[this.cursor].path
    this.confirmSensitive = null
    this.fitScroll(view.length)
    if (this.selectMode && this.rangeStart !== null)
      this.applyRange(view)
  }

  private applyRange(view: CleanResult[]): void {
    const anchor = view[this.rangeStart!]
    if (!anchor)
      return
    const select = this.selected.has(anchor.path)
    const [from, to] = [Math.min(this.rangeStart!, this.cursor), Math.max(this.rangeStart!, this.cursor)]
    for (let i = from; i <= to; i++) {
      if (select)
        this.selected.add(view[i].path)
      else
        this.selected.delete(view[i].path)
    }
  }

  private handleListKey(key: TuiKey): void {
    const { name } = key
    const view = this.getViewResults()
    const current = view[this.cursor]
    const page = Math.max(1, this.bodyRows - 2)

    if ((name === 'g' && key.shift) || key.sequence === 'G')
      return this.moveCursor(view.length)

    switch (name) {
      case 'up':
      case 'k':
        return this.moveCursor(-1)
      case 'down':
      case 'j':
        return this.moveCursor(1)
      case 'pageup':
      case 'u':
        return this.moveCursor(-page)
      case 'pagedown':
      case 'd':
        return this.moveCursor(page)
      case 'home':
      case 'g':
        return this.moveCursor(-view.length)
      case 'end':
        return this.moveCursor(view.length)
      case 'space':
      case 'delete':
        if (this.selectMode) {
          if (current) {
            if (this.selected.has(current.path))
              this.selected.delete(current.path)
            else
              this.selected.add(current.path)
          }
        }
        else if (current) {
          this.requestDelete(current)
        }
        return
      case 'return':
      case 'enter':
        if (this.selectMode)
          this.deleteSelected(view)
        return
      case 't':
        this.selectMode = !this.selectMode
        this.rangeStart = null
        if (!this.selectMode)
          this.selected.clear()
        return
      case 'v':
        if (!this.selectMode)
          return
        if (this.rangeStart !== null) {
          this.rangeStart = null
        }
        else if (current) {
          this.rangeStart = this.cursor
          if (this.selected.has(current.path))
            this.selected.delete(current.path)
          else
            this.selected.add(current.path)
        }
        return
      case 'a':
        if (!this.selectMode)
          return
        if (view.every(r => this.selected.has(r.path)))
          view.forEach(r => this.selected.delete(r.path))
        else
          view.forEach(r => this.selected.add(r.path))
        return
      case 's':
        this.config.sortBy = CLEAN_SORT_CHOICES[(CLEAN_SORT_CHOICES.indexOf(this.config.sortBy) + 1) % CLEAN_SORT_CHOICES.length]
        this.setMessage(`Sort by ${c.cyan(this.config.sortBy)}`, 1500)
        return
      case 'o':
        if (current)
          this.openFolder(dirname(current.path))
        return
      case 'e':
        this.view = 'errors'
        return
      case 'q':
      case 'escape':
        if (name === 'escape' && this.searchText) {
          this.searchText = ''
          return
        }
        void this.quit()
        return
    }
    if (key.sequence === '/') {
      this.searchInput = true
      return
    }
    if (key.sequence === '?')
      this.view = 'help'
  }

  private handleDetailsKey(key: TuiKey): void {
    const current = this.getViewResults()[this.cursor]
    switch (key.name) {
      case 'escape':
      case 'q':
        this.view = 'list'
        return
      case 'o':
        if (current)
          this.openFolder(dirname(current.path))
        return
      case 'space':
      case 'delete':
        if (current)
          this.requestDelete(current)
    }
  }

  private handleOptionsKey(key: TuiKey): void {
    const items = this.getOptionItems()
    switch (key.name) {
      case 'up':
      case 'k':
        this.optionIndex = (this.optionIndex - 1 + items.length) % items.length
        return
      case 'down':
      case 'j':
        this.optionIndex = (this.optionIndex + 1) % items.length
        return
      case 'space':
      case 'return':
      case 'enter': {
        const item = items[this.optionIndex]
        if (item.type === 'input')
          this.editing = { index: this.optionIndex, value: String(item.get()) }
        else
          item.toggle?.()
        return
      }
      case 'escape':
      case 'q':
        this.view = 'list'
    }
  }

  private requestDelete(result: CleanResult): void {
    if (result.status === 'deleted' || result.status === 'deleting')
      return
    if (result.riskAnalysis.isSensitive && this.confirmSensitive !== result.path) {
      this.confirmSensitive = result.path
      this.setMessage(c.yellowBright(`⚠️  ${result.riskAnalysis.reason ?? 'Sensitive directory'}. Press SPACE again to delete it.`), 5000)
      return
    }
    this.confirmSensitive = null
    void this.session.delete(result)
  }

  private deleteSelected(view: CleanResult[]): void {
    const targets = view.filter(r => this.selected.has(r.path))
    if (!targets.length)
      return
    for (const result of targets)
      void this.session.delete(result)
    this.selected.clear()
    this.rangeStart = null
  }

  private openFolder(path: string): void {
    try {
      (this.options.openFolder ?? openFolderDefault)(path)
    }
    catch (e) {
      this.session.addError(`Cannot open ${path}: ${(e as Error).message}`)
    }
  }
}
