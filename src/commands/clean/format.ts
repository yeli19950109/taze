import type { CleanResult, CleanSizeUnit, CleanSortBy } from './types'
import { stripVTControlCharacters } from 'node:util'

const MB = 1024 ** 2
const GB = 1024 ** 3
const DAY = 86_400_000

/** npkill style: whole MB below 1 GB, GB with 2 decimals above. */
export function formatSize(bytes: number, unit: CleanSizeUnit = 'auto', decimals = 2): string {
  if (unit === 'gb' || (unit === 'auto' && bytes >= GB))
    return `${(bytes / GB).toFixed(decimals)} GB`
  return `${Math.round(bytes / MB)} MB`
}

export function getAgeInDays(modificationTime: number, now = Date.now()): number {
  return Math.floor((now - modificationTime) / DAY)
}

/** Unknown ages (`null` / `0`) are never considered old. */
export function isOlderThan(modificationTime: number | null, days: number, now = Date.now()): boolean {
  if (!modificationTime || modificationTime <= 1)
    return false
  return (now - modificationTime) / DAY > days
}

const byPath = (a: CleanResult, b: CleanResult) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0

const RESULT_SORT: Record<Exclude<CleanSortBy, 'none'>, (a: CleanResult, b: CleanResult) => number> = {
  path: byPath,
  size: (a, b) => {
    const sa = a.size ?? -1
    const sb = b.size ?? -1
    return sa !== sb ? sb - sa : byPath(a, b)
  },
  age: (a, b) => {
    const ma = a.modificationTime || null
    const mb = b.modificationTime || null
    if (ma === mb)
      return byPath(a, b)
    if (ma === null)
      return 1
    if (mb === null)
      return -1
    return ma - mb
  },
}

export function sortResults(results: CleanResult[], sortBy: CleanSortBy): CleanResult[] {
  if (sortBy === 'none')
    return results.slice()
  return results.slice().sort(RESULT_SORT[sortBy])
}

// ---- terminal width helpers ----

function isWide(code: number): boolean {
  return code >= 0x1100 && (
    code <= 0x115F
    || code === 0x2329 || code === 0x232A
    || (code >= 0x2E80 && code <= 0xA4CF && code !== 0x303F)
    || (code >= 0xAC00 && code <= 0xD7A3)
    || (code >= 0xF900 && code <= 0xFAFF)
    || (code >= 0xFE30 && code <= 0xFE4F)
    || (code >= 0xFF00 && code <= 0xFF60)
    || (code >= 0xFFE0 && code <= 0xFFE6)
    || (code >= 0x1F300 && code <= 0x1F64F)
    || (code >= 0x1F900 && code <= 0x1F9FF)
    || (code >= 0x20000 && code <= 0x3FFFD)
  )
}

function charWidth(code: number): number {
  if (code <= 0x1F || (code >= 0x7F && code <= 0x9F))
    return 0
  if ((code >= 0x300 && code <= 0x36F) || code === 0x200D || (code >= 0xFE00 && code <= 0xFE0F))
    return 0
  return isWide(code) ? 2 : 1
}

export function textWidth(text: string): number {
  let width = 0
  for (const char of stripVTControlCharacters(text))
    width += charWidth(char.codePointAt(0)!)
  return width
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /^\u001B\[[0-9;?]*[A-Z]/i

/**
 * Cuts a string (that may contain ANSI colors) to `width` visible columns and
 * pads it with spaces up to exactly `width`.
 */
export function fitText(text: string, width: number, pad = true): string {
  if (width <= 0)
    return ''
  let out = ''
  let visible = 0
  let i = 0
  let truncated = false
  while (i < text.length) {
    const ansi = ANSI_RE.exec(text.slice(i, i + 32))
    if (ansi) {
      out += ansi[0]
      i += ansi[0].length
      continue
    }
    const code = text.codePointAt(i)!
    const char = String.fromCodePoint(code)
    const w = charWidth(code)
    if (visible + w > width) {
      truncated = true
      break
    }
    out += char
    visible += w
    i += char.length
  }
  if (truncated)
    out += '\u001B[0m'
  return pad && visible < width ? out + ' '.repeat(width - visible) : out
}

/**
 * Shortens a plain string to `width` columns keeping the start and the end
 * (the end of a path is usually the interesting part).
 */
export function shortenMiddle(text: string, width: number, keepStart = 8): string {
  if (textWidth(text) <= width)
    return text
  if (width <= 3)
    return '.'.repeat(Math.max(0, width))
  const chars = [...text]
  const start = Math.min(keepStart, Math.max(0, width - 3 - 4))
  let end = ''
  let endWidth = 0
  const budget = width - 3 - start
  for (let i = chars.length - 1; i >= start; i--) {
    const w = charWidth(chars[i].codePointAt(0)!)
    if (endWidth + w > budget)
      break
    end = chars[i] + end
    endWidth += w
  }
  return `${chars.slice(0, start).join('')}...${end}`
}

export function wrapText(text: string, width: number): string[] {
  const lines: string[] = []
  for (const paragraph of text.split('\n')) {
    let line = ''
    for (const word of paragraph.split(' ')) {
      if (line && textWidth(`${line} ${word}`) > width) {
        lines.push(line)
        line = word
      }
      else {
        line = line ? `${line} ${word}` : word
      }
    }
    lines.push(line)
  }
  return lines
}

/** Splits a string (without spaces, like a path) into chunks of `width` columns. */
export function chunkText(text: string, width: number): string[] {
  const chunks: string[] = []
  let current = ''
  let currentWidth = 0
  for (const char of text) {
    const w = charWidth(char.codePointAt(0)!)
    if (currentWidth + w > width && current) {
      chunks.push(current)
      current = ''
      currentWidth = 0
    }
    current += char
    currentWidth += w
  }
  if (current || !chunks.length)
    chunks.push(current)
  return chunks
}
