import type { CAC } from 'cac'
import type { CleanCliOptions } from './config'
import process from 'node:process'
import { runClean } from './run'

export { resolveCleanConfig } from './config'
export { analyzeRisk, isSafeToDelete } from './risk'
export { runClean } from './run'
export { CleanSession } from './session'
export { CleanTui } from './tui'
export type { CleanConfig } from './types'

export function registerCleanCommands(cli: CAC, version?: string): void {
  cli
    .command('clean [dir]', 'Find and delete node_modules and other junk directories (npkill)')
    .option('--directory, -d <dir>', 'directory to start searching from (default: cwd)')
    .option('--full, -f', 'start searching from the user\'s home directory')
    .option('--profiles, -p [profiles]', 'profiles of targets to search, comma separated (default: node). Without a value, lists the profiles')
    .option('--targets, -t <targets>', 'directory names to search for, comma separated (disables profiles)')
    .option('--exclude, -E <paths>', 'exclude paths from the search, comma separated')
    .option('--exclude-sensitive, -x', 'exclude sensitive directories (inside apps, hidden home folders...)')
    .option('--delete-all, -D', 'delete every target found')
    .option('--yes, -y', 'don\'t ask for confirmation with --delete-all')
    .option('--dry-run', 'don\'t delete anything, only simulate it')
    .option('--json', 'output the results as a JSON object')
    .option('--json-stream', 'output each result as a JSON line as soon as it\'s ready')
    .option('--no-size', 'skip size calculation')
    .option('--no-age', 'skip age (last modification) calculation')
    .option('--no-stats', 'skip both size and age calculation')
    .option('--older-than <days>', 'only show results whose project wasn\'t modified in more than <days> days')
    .option('--sort, -s <by>', 'sort results by: none | size | path | age')
    .option('--size-unit <unit>', 'size unit: auto | mb | gb')
    .option('--hide-errors, -e', 'hide errors')
    .option('--config <path>', 'path to a .npkillrc file (default: ./.npkillrc, then ~/.npkillrc)')
    .option('--concurrency <n>', 'max directories read concurrently while scanning (default: 16)')
    .action(async (dir: string | undefined, options: CleanCliOptions) => {
      // A bigger libuv threadpool speeds up the many small fs calls of a scan.
      // It only takes effect if no async fs call happened yet.
      process.env.UV_THREADPOOL_SIZE ??= '16'
      process.exit(await runClean(dir, options, { version }))
    })
}
