/** Package closure, locale parity and bilingual documentation checks over final artifacts. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, access, stat } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))
test('the bundle exports its built client, localized metadata and existing artwork', async () => {
  const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
  assert.equal(manifest.name, 'dsh-websocket')
  assert.equal(manifest.dsh.client.platform, 'web')
  for (const file of ['lib/index.js', 'lib/client.js', 'icon.svg', manifest.dsh.bundle.patch]) await access(resolve(root, file))
  for (const locale of ['en', 'zh']) {
    const copy = JSON.parse(await readFile(resolve(root, `locale/${locale}.json`), 'utf8'))
    assert.ok(copy.meta.title.length); assert.ok(copy.meta.description.length)
  }
  const client = await readFile(resolve(root, 'lib/client.js'), 'utf8')
  assert.ok(client.includes("id: 'dsh-websocket'")); assert.ok(client.includes("require('react')")); assert.ok(!client.includes('/*__DICTIONARIES__*/'))
  const requests = [...new Set([...client.matchAll(/\brequire\((['"])([^'"]+)\1\)/gu)].map(match => match[2]))].sort()
  assert.deepEqual(requests, ['@deepseek-ai/dsh-client-ui-primitives', 'react'], 'only browser platform modules may be required')
  for (const file of ['src/continuation.ts', 'src/circuit.ts', 'src/management.ts', 'src/client.js', 'tests/reuse.test.ts']) assert.ok((await stat(resolve(root, file))).size > 100, `${file} is not an empty deliverable`)
})
test('README pairs align structurally, retain valid local links, and end in one newline', async () => {
  const texts = await Promise.all(['README.md', 'README.zh.md'].map(file => readFile(resolve(root, file), 'utf8')))
  assert.equal(texts[0]!.split('\n').length, texts[1]!.split('\n').length)
  for (let index = 0; index < texts.length; index++) {
    const text = texts[index]!
    assert.ok(text.endsWith('\n') && !text.endsWith('\n\n'))
    const headings = text.split('\n').filter(line => line.startsWith('#')).map(line => line.split(' ')[0])
    assert.deepEqual(headings, texts[0]!.split('\n').filter(line => line.startsWith('#')).map(line => line.split(' ')[0]))
    for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
      const link = match[1]!
      if (link.startsWith('#') || /^https?:/.test(link)) continue
      await access(resolve(dirname(resolve(root, 'README.md')), link.split('#')[0]!))
    }
  }
})
