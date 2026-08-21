import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { disable, enable } from 'obug'
import { afterEach, expect, it, vi } from 'vitest'
import { loadPackages } from '../src/manifests'

let cwd: string | undefined

function writeJson(relative: string, value: unknown) {
  const filepath = path.join(cwd!, relative)
  fs.mkdirSync(path.dirname(filepath), { recursive: true })
  fs.writeFileSync(filepath, JSON.stringify(value), 'utf8')
}

afterEach(() => {
  if (cwd)
    fs.rmSync(cwd, { recursive: true, force: true })
  cwd = undefined
  vi.restoreAllMocks()
})

it('reports discovered workspaces, dependencies, and nested-workspace exclusions', async () => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'taze-workspace-debug-'))
  writeJson('package.json', {
    name: 'root',
    private: true,
    dependencies: { react: '^18.0.0' },
  })
  writeJson('packages/a/package.json', {
    name: '@scope/a',
    devDependencies: { typescript: '^6.0.0' },
  })
  writeJson('nested/packages/b/package.json', {
    name: '@scope/b',
    dependencies: { vue: '^3.0.0' },
  })
  fs.writeFileSync(path.join(cwd, 'nested/pnpm-workspace.yaml'), 'packages:\n  - packages/*\n', 'utf8')

  let output = ''
  const write = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString()
    return true
  }) as typeof process.stderr.write)

  const previous = disable()
  enable('taze:workspace')
  try {
    await loadPackages({ cwd, recursive: true, ignoreOtherWorkspaces: true })
  }
  finally {
    enable(previous)
    write.mockRestore()
  }

  expect(output).toContain(`scan root=${cwd}`)
  expect(output).toContain('workspace path=package.json name=root')
  expect(output).toContain('workspace path=packages/a/package.json name=@scope/a')
  expect(output).toContain('name: \'react\'')
  expect(output).toContain('version: \'^18.0.0\'')
  expect(output).toContain('source: \'dependencies\'')
  expect(output).toContain('exclude nested/packages/b/package.json: nested pnpm workspace')
  expect(output).not.toContain('workspace path=nested/packages/b/package.json')
  expect(output).not.toContain('taze:resolve')
})
