/** Regression checks over the actual affected pnpm implementation and real offline pnpm CLI. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import vm from 'node:vm'
import { spawn } from 'node:child_process'
import { target, prepare, digest, atomicReplace } from './backport.mjs'
const plan = await prepare()
console.log(JSON.stringify({ step: 'prepared', directory: plan.directory, livePnpmChanged: false }))
const original = await fs.readFile(target, 'utf8')
const patched = await fs.readFile(plan.candidate, 'utf8')
async function implementation(source, directory, { failPermission = false, scopes = ['@race', '@other'] } = {}) {
  const modulesDir = path.join(directory, 'node_modules')
  await fs.mkdir(modulesDir, { recursive: true })
  const previous = {}, projectIds = new Set(), destinations = [], pending = new Set(), rmdirCalls = []
  for (const scope of scopes) for (const suffix of ['a', 'b', 'c']) {
    const alias = `${scope}/${suffix}`, project = `packages/${scope.slice(1)}-${suffix}`, destination = path.join(modulesDir, alias), projectDir = path.join(directory, project)
    await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.mkdir(projectDir, { recursive: true }); await fs.symlink(projectDir, destination, 'junction')
    previous[project] = { [alias]: 'public' }; projectIds.add(project); destinations.push(destination)
  }
  const code = source.slice(source.indexOf('async function pruneStaleWorkspaceHoists('), source.indexOf('var init_hoistWorkspacePackages ='))
  assert.ok(code.startsWith('async function pruneStaleWorkspaceHoists('))
  const entry = vm.runInNewContext(`${code}\npruneStaleWorkspaceHoists`, {
    Map, Set, Array, Promise, process: { platform: process.platform },
    path160: path, isError: value => value instanceof Error,
    fs107: { promises: { ...fs, rmdir: async directory => {
      rmdirCalls.push(directory)
      if (failPermission) throw Object.assign(new Error('genuine permission refusal'), { code: 'EACCES' })
      if (pending.has(directory)) throw Object.assign(new Error('Windows pending-delete race'), { code: 'EPERM' })
      pending.add(directory)
      try { await new Promise(done => setImmediate(done)); await fs.rmdir(directory) } finally { pending.delete(directory) }
    } } },
    getTrustedRoot: (_public, modules) => modules,
    validateWorkspaceModulesDir: async (modules, alias) => { const result = path.join(modules, alias); assert.ok(result.startsWith(modules + path.sep)); return result },
    prepareWorkspaceModulesDir: async (modules, alias) => { const result = path.join(modules, alias); await fs.mkdir(path.dirname(result), { recursive: true }); return result },
    selectHoistedModulesDir: (_type, dirs) => dirs.publicHoistedModulesDir,
  })
  let failure
  try { await entry(previous, {}, projectIds, modulesDir, modulesDir) } catch (error) { failure = error }
  return { failure, rmdirCalls, destinations }
}
const before = await implementation(original, path.join(plan.directory, 'unit-before'))
console.log(JSON.stringify({ step: 'unit-baseline', error: before.failure?.message, code: before.failure?.code, rmdirCalls: before.rmdirCalls }))
assert.equal(before.failure?.code, 'EPERM', 'the old implementation must reproduce the Windows duplicate-parent race')
const after = await implementation(patched, path.join(plan.directory, 'unit-after'))
assert.equal(after.failure, undefined)
assert.equal(after.rmdirCalls.length, 2, 'two distinct scope directories are each removed exactly once')
const refused = await implementation(patched, path.join(plan.directory, 'unit-permission'), { failPermission: true })
assert.equal(refused.failure?.code, 'EACCES', 'the fix must not hide actual permission failures')
for (const destination of refused.destinations) assert.equal((await fs.lstat(destination)).isSymbolicLink(), true, 'real failures still restore all removed links')
const restoredCandidate = path.join(plan.directory, 'candidate-pnpm', 'dist', 'rollback-check.mjs')
await atomicReplace(restoredCandidate, Buffer.from(patched)); await atomicReplace(restoredCandidate, Buffer.from(original))
assert.equal(digest(await fs.readFile(restoredCandidate)), plan.originalSHA256)
await fs.writeFile(path.join(plan.directory, 'unit-results.json'), JSON.stringify({ oldRaceReproduced: true, fixedEachParentOnce: true, genuinePermissionsPreserved: true, rollbackRestoredLinks: true, atomicRestoreVerified: true }, null, 2))
async function cli(entry, cwd, args, label) {
  const log = path.join(plan.directory, `${label}.log`), fd = await fs.open(log, 'w')
  const env = { ...process.env }; delete env.UV_THREADPOOL_SIZE; delete env.NODE_OPTIONS
  Object.assign(env, { npm_config_manage_package_manager_versions: 'false', npm_config_package_manager_strict: 'false' })
  const child = spawn(process.execPath, [entry, ...args, '--config.manage-package-manager-versions=false'], { cwd, env, stdio: ['ignore', fd.fd, fd.fd] })
  let expired = false
  const deadline = setTimeout(() => { expired = true; child.kill() }, 30000)
  const code = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done) }).finally(async () => { clearTimeout(deadline); await fd.close() })
  assert.equal(expired, false, 'each CLI invocation exits within its bound')
  return { code, text: await fs.readFile(log, 'utf8'), log }
}
async function workspace(label) {
  const cwd = path.join(plan.directory, label); await fs.mkdir(cwd)
  await fs.writeFile(path.join(cwd, 'package.json'), JSON.stringify({ name: label, private: true, packageManager: 'pnpm@11.28.5' }))
  await fs.writeFile(path.join(cwd, 'pnpm-workspace.yaml'), JSON.stringify({ packages: ['packages/*'], nodeLinker: 'hoisted', verifyDepsBeforeRun: false }))
  for (let index = 0; index < 16; index++) {
    const directory = path.join(cwd, 'packages', `pkg-${index}`); await fs.mkdir(directory, { recursive: true })
    await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: `@race/pkg-${index}`, version: '1.0.0' }))
  }
  return cwd
}
const oldWorkspace = await workspace('baseline-workspace')
let originalFailures = 0, originalRuns = 0
for (let run = 0; run < 15; run++) {
  const result = await cli(target, oldWorkspace, ['install', '--force', '--offline', '--ignore-scripts'], `old-${run}`); originalRuns++
  if (result.code !== 0) { assert.match(result.text, /EPERM[\s\S]*rmdir/); originalFailures++; break }
}
console.log(JSON.stringify({ step: 'baseline-cli', runs: originalRuns, failures: originalFailures }))
const fixedWorkspace = await workspace('fixed-workspace')
for (let run = 0; run < 20; run++) {
  const result = await cli(plan.candidate, fixedWorkspace, ['install', '--force', '--offline', '--ignore-scripts'], `fixed-${run}`)
  assert.equal(result.code, 0, result.text)
}
// An uninstall/add cycle also exercises the same stale-hoist parent cleanup path.
const dependency = path.join(fixedWorkspace, 'standalone-dependency'); await fs.mkdir(dependency)
await fs.writeFile(path.join(dependency, 'package.json'), JSON.stringify({ name: 'pnpm-repair-fixture', version: '1.0.0' }))
for (let run = 0; run < 3; run++) {
  const added = await cli(plan.candidate, fixedWorkspace, ['add', '-w', dependency, '--offline', '--ignore-scripts'], `add-${run}`); assert.equal(added.code, 0, added.text)
  const removed = await cli(plan.candidate, fixedWorkspace, ['remove', '-w', 'pnpm-repair-fixture'], `remove-${run}`); assert.equal(removed.code, 0, removed.text)
}
const verified = { passed: true, patchedSHA256: plan.patchedSHA256, originalSHA256: plan.originalSHA256, originalRuns, originalFailures, patchedRepeatedInstalls: 20, patchedAddRemoveCycles: 3, defaultThreadpool: true, noNetworkDependencies: true, installScriptsExecuted: false, livePnpmChanged: false }
assert.equal(digest(await fs.readFile(target)), plan.originalSHA256, 'verification did not mutate the installed package manager')
await fs.writeFile(path.join(plan.directory, 'verified.json'), JSON.stringify(verified, null, 2) + '\n')
console.log(JSON.stringify({ step: 'verified', directory: plan.directory, ...verified }))
