/** Exact backport of pnpm PR #16693 to the pinned local pnpm 11.28.5, with hash-guarded rollback. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
export const target = 'D:\\deepseek-harness\\node_modules\\.pnpm\\pnpm@11.28.5\\node_modules\\pnpm\\dist\\pnpm.mjs'
export const packageRoot = path.dirname(path.dirname(target))
export const root = fileURLToPath(new URL('./', import.meta.url))
export const upstream = 'https://github.com/pnpm/pnpm/pull/16693'
export const digest = value => createHash('sha256').update(value).digest('hex')
const oldLine = '  const parentCleanupResults = await Promise.allSettled(staleLinks.map(removeEmptyParentsOfWorkspaceLink));'
const newLine = '  const parentCleanupResults = await Promise.allSettled(selectOneLinkPerParent(staleLinks).map(removeEmptyParentsOfWorkspaceLink));'
const anchor = 'async function removeEmptyParentsOfWorkspaceLink({ alias, destination, modulesDir, trustedRoot }) {'
const helper = `// Backport of pnpm PR #16693 (included in pnpm 11.28.6); do not swallow permission failures.
function selectOneLinkPerParent(links) {
  const linksByParent = new Map();
  for (const link of links) {
    const parent = path160.dirname(link.destination);
    if (!linksByParent.has(parent)) linksByParent.set(parent, link);
  }
  return Array.from(linksByParent.values());
}
`
export function patch(source) {
  assert.equal(source.split(oldLine).length, 2, 'one exact affected call site is required')
  assert.equal(source.split(anchor).length, 2, 'one exact helper anchor is required')
  assert.equal(source.includes('function selectOneLinkPerParent('), false, 'refuse to patch an already changed pnpm')
  return source.replace(oldLine, newLine).replace(anchor, helper + anchor)
}
export async function atomicReplace(destination, bytes) {
  const absolute = path.resolve(destination)
  assert.ok(absolute === path.resolve(target) || absolute.startsWith(path.resolve(root) + path.sep), 'replacement is confined to the one known pnpm entry or this repair workspace')
  const temporary = `${absolute}.pnpm-repair-${randomUUID()}.tmp`
  await fs.writeFile(temporary, bytes, { flag: 'wx' })
  // Atomic replacement breaks any content-store hardlink rather than editing its shared inode.
  await fs.rename(temporary, absolute)
  assert.equal(digest(await fs.readFile(absolute)), digest(bytes))
}
export async function prepare() {
  const manifest = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'))
  assert.equal(manifest.name, 'pnpm'); assert.equal(manifest.version, '11.28.5')
  const before = await fs.readFile(target), after = Buffer.from(patch(before.toString('utf8')))
  const backups = path.join(root, 'backups')
  await fs.mkdir(backups, { recursive: true })
  const directory = await fs.mkdtemp(path.join(backups, 'pnpm-11.28.5-'))
  await fs.writeFile(path.join(directory, 'pnpm.mjs.original'), before, { flag: 'wx' })
  const candidate = path.join(directory, 'candidate-pnpm')
  await fs.cp(packageRoot, candidate, { recursive: true })
  await atomicReplace(path.join(candidate, 'dist', 'pnpm.mjs'), after)
  const plan = { target, upstream, originalSHA256: digest(before), patchedSHA256: digest(after), directory, candidate: path.join(candidate, 'dist', 'pnpm.mjs'), applied: false }
  await fs.writeFile(path.join(directory, 'plan.json'), JSON.stringify(plan, null, 2) + '\n')
  return plan
}
export async function apply(directory) {
  const plan = JSON.parse(await fs.readFile(path.join(directory, 'plan.json'), 'utf8'))
  const verified = JSON.parse(await fs.readFile(path.join(directory, 'verified.json'), 'utf8'))
  assert.equal(plan.target, target); assert.equal(verified.patchedSHA256, plan.patchedSHA256); assert.equal(verified.passed, true)
  const current = await fs.readFile(target)
  assert.equal(digest(current), plan.originalSHA256, 'installed pnpm changed since preparation; do not overwrite it')
  const candidate = await fs.readFile(plan.candidate)
  assert.equal(digest(candidate), plan.patchedSHA256)
  assert.equal(digest(await fs.readFile(path.join(directory, 'pnpm.mjs.original'))), plan.originalSHA256)
  await atomicReplace(target, candidate)
  plan.applied = true
  await fs.writeFile(path.join(directory, 'plan.json'), JSON.stringify(plan, null, 2) + '\n')
  return plan
}
export async function restore(directory) {
  const plan = JSON.parse(await fs.readFile(path.join(directory, 'plan.json'), 'utf8'))
  assert.equal(plan.target, target)
  assert.equal(digest(await fs.readFile(target)), plan.patchedSHA256, 'refuse to overwrite an independently changed pnpm during rollback')
  const original = await fs.readFile(path.join(directory, 'pnpm.mjs.original'))
  assert.equal(digest(original), plan.originalSHA256)
  await atomicReplace(target, original)
  return { restored: true, target, sha256: plan.originalSHA256 }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, directory] = process.argv.slice(2)
  if (mode === 'prepare') console.log(JSON.stringify(await prepare()))
  else if (mode === 'apply') console.log(JSON.stringify(await apply(path.resolve(directory))))
  else if (mode === 'restore') console.log(JSON.stringify(await restore(path.resolve(directory))))
  else throw new Error('Use prepare, apply <backup directory>, or restore <backup directory>.')
}
