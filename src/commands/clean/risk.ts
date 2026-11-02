import type { RiskAnalysis } from './types'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

function normalizePath(p: string): string {
  let normalized = p.replace(/\\/g, '/').toLowerCase()
  if (/^[a-z]:\//.test(normalized))
    normalized = normalized.substring(2)
  return normalized
}

export function getHomeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? os.homedir() ?? ''
}

/**
 * Ported from npkill's `isDangerous`.
 *
 * If a target lives inside a hidden directory it's probably required by some
 * application (Spotify, VS Code, Discord...) and deleting it would break that
 * application until the dependencies are reinstalled. macOS application
 * bundles and Windows AppData / Program Files are treated the same way.
 */
export function analyzeRisk(originalPath: string, home = getHomeDir()): RiskAnalysis {
  const isUnc = originalPath.startsWith('\\\\') || originalPath.startsWith('//')
  const absolutePath = isUnc || path.isAbsolute(originalPath)
    ? originalPath
    : path.resolve(process.cwd(), originalPath)

  const normalizedPath = normalizePath(absolutePath)
  const normalizedOriginal = normalizePath(originalPath)

  if (home !== '') {
    const normalizedHome = normalizePath(path.isAbsolute(home) ? home : path.resolve(home)).replace(/\/+$/, '')
    const isInHome = normalizedPath === normalizedHome || normalizedPath.startsWith(`${normalizedHome}/`)

    if (isInHome) {
      let rel = normalizedPath.slice(normalizedHome.length)
      if (rel.startsWith('/'))
        rel = rel.slice(1)

      if (rel === '.config' || rel.startsWith('.config/'))
        return { isSensitive: true, reason: 'Contains user configuration data (~/.config)' }
      if (rel === '.local/share' || rel.startsWith('.local/share/'))
        return { isSensitive: true, reason: 'User data folder (~/.local/share)' }
      if (rel === '.cache' || rel.startsWith('.cache/'))
        return { isSensitive: true, reason: 'System-wide cache directory (~/.cache)' }
      if (/^\.(?:npm|pnpm)(?:\/|$)/.test(rel))
        return { isSensitive: false }

      const topLevel = rel.split('/')[0] ?? ''
      if (topLevel.startsWith('.') && topLevel !== '.' && topLevel !== '..')
        return { isSensitive: true, reason: 'Contains unsafe hidden folder' }
    }
  }

  // macOS
  if (/\/applications\/[^/]+\.app\//.test(normalizedPath))
    return { isSensitive: true, reason: 'Inside macOS .app package' }

  // Windows UNC network paths (e.g., \\server\share -> //server/share)
  if (normalizedOriginal.startsWith('//') && /\/\.[^/]+(?:\/|$)/.test(normalizedOriginal))
    return { isSensitive: true, reason: 'Hidden path in network share' }

  // Windows
  if (normalizedPath.includes('/appdata/roaming'))
    return { isSensitive: true, reason: 'Inside Windows AppData Roaming folder' }
  if (normalizedPath.includes('/appdata/local')) {
    if (/\/\.(?:cache|npm|pnpm)(?:\/|$)/.test(normalizedPath))
      return { isSensitive: false }
    return { isSensitive: true, reason: 'Inside Windows AppData Local folder' }
  }
  if (/program files(?: \(x86\))?\//.test(normalizedPath))
    return { isSensitive: true, reason: 'Inside Program Files folder' }

  return { isSensitive: false }
}

/** Last line of defense: only delete directories whose name is a target. */
export function isSafeToDelete(filePath: string, targets: string[]): boolean {
  const name = path.basename(filePath)
  if (!name)
    return false
  return targets.includes(name)
}
