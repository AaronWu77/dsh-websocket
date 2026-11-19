/** Verify the installed pnpm's public bin entry, but run mutations only in a new repair-owned workspace. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { target, packageRoot, root, digest } from './backport.mjs'
const directory = path.resolve(process.argv[2])
assert.ok(directory.startsWith(path.join(root, 'backups') + path.sep))
const plan = JSON.parse(await fs.readFile(path.join(directory, 'plan.json'), 'utf8'))
assert.equal(plan.target, target); assert.equal(plan.applied, true)
assert.equal(digest(await fs.readFile(target)), plan.patchedSHA256)
const cwd = await fs.mkdtemp(path.join(directory, 'installed-entry-check-'))
await fs.writeFile(path.join(cwd, 'package.json'), JSON.stringify({ name: 'installed-pnpm-verification', private: true, packageManager: 'pnpm@11.28.5' }))
await fs.writeFile(path.join(cwd, 'pnpm-workspace.yaml'), JSON.stringify({ packages: ['packages/*'], nodeLinker: 'hoisted', verifyDepsBeforeRun: false }))
for (let index = 0; index < 16; index++) {
  const project = path.join(cwd, 'packages', `project-${index}`); await fs.mkdir(project, { recursive: true })
  await fs.writeFile(path.join(project, 'package.json'), JSON.stringify({ name: `@race/project-${index}`, version: '1.0.0' }))
}
async function run(args, label) {
  const log = path.join(cwd, `${label}.log`), handle = await fs.open(log, 'w')
  const env = { ...process.env }; delete env.UV_THREADPOOL_SIZE; delete env.NODE_OPTIONS
  const child = spawn(process.execPath, [path.join(packageRoot, 'bin', 'pnpm.mjs'), ...args], { cwd, env, stdio: ['ignore', handle.fd, handle.fd] })
  let expired = false
  const timer = setTimeout(() => { expired = true; child.kill() }, 30000)
  const code = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done) }).finally(async () => { clearTimeout(timer); await handle.close() })
  const text = await fs.readFile(log, 'utf8')
  assert.equal(expired, false); assert.equal(code, 0, text)
  return text
}
assert.equal((await run(['--version'], 'version')).trim(), '11.28.5')
for (let runIndex = 0; runIndex < 10; runIndex++) await run(['install', '--force', '--offline', '--ignore-scripts'], `install-${runIndex}`)
const dependency = path.join(cwd, 'standalone'); await fs.mkdir(dependency)
await fs.writeFile(path.join(dependency, 'package.json'), JSON.stringify({ name: 'installed-entry-local-fixture', version: '1.0.0' }))
for (let runIndex = 0; runIndex < 3; runIndex++) {
  await run(['add', '-w', dependency, '--offline', '--ignore-scripts'], `add-${runIndex}`)
  await run(['remove', '-w', 'installed-entry-local-fixture'], `remove-${runIndex}`)
}
assert.equal(digest(await fs.readFile(target)), plan.patchedSHA256)
const result = { passed: true, target, version: '11.28.5 with upstream PR #16693 backport', patchedSHA256: plan.patchedSHA256, normalThreadpool: true, repeatedForcedInstalls: 10, addRemoveCycles: 3, liveProfileMutations: 0, evidenceDirectory: cwd }
await fs.writeFile(path.join(directory, 'installed-verification.json'), JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify(result))
