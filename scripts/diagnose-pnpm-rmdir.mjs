/** Reproduce only inside a fresh candidate-owned temporary tree. Never changes the live profile. */
import fs from 'node:fs/promises'
import path from 'node:path'
const parent = path.resolve('.tmp')
await fs.mkdir(parent, { recursive: true })
const root = await fs.mkdtemp(path.join(parent, 'rmdir-diagnostic-'))
const target = path.join(root, 'target')
await fs.mkdir(target)
for (const kind of ['ordinary', 'junction']) {
  const scope = path.join(root, kind, '@fixture')
  await fs.mkdir(scope, { recursive: true })
  const child = path.join(scope, 'child')
  if (kind === 'junction') await fs.symlink(target, child, 'junction')
  else await fs.mkdir(child)
  try { await fs.rmdir(scope); console.log(JSON.stringify({ kind, result: 'unexpectedly-removed-nonempty-directory' })) }
  catch (error) { console.log(JSON.stringify({ kind, result: 'refused-nonempty-directory', code: error.code, syscall: error.syscall, message: error.message })) }
}
const counts = {}
for (let run = 0; run < 30; run++) {
  const scope = path.join(root, `race-${run}`, '@fixture')
  await fs.mkdir(scope, { recursive: true })
  const children = Array.from({ length: 32 }, (_, i) => path.join(scope, `dependency-${i}`))
  await Promise.all(children.map(child => fs.symlink(target, child, 'junction')))
  await Promise.all(children.map(child => fs.unlink(child)))
  const results = await Promise.allSettled(children.map(() => fs.rmdir(scope)))
  for (const result of results) { const code = result.status === 'fulfilled' ? 'removed' : result.reason.code; counts[code] = (counts[code] ?? 0) + 1 }
}
console.log(JSON.stringify({ scenario: 'parallel-cleanup-of-the-same-empty-scope-after-unlinking-junctions', rounds: 30, counts }))
console.log(JSON.stringify({ evidenceDirectory: root, node: process.version, platform: process.platform, liveProfileChanged: false }))
