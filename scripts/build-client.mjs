/** Assemble the browser factory using only the host's React and Cordis module identities. */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')
const css = await readFile(new URL('../src/client.css', import.meta.url), 'utf8')
const en = JSON.parse(await readFile(new URL('../locale/ui-en.json', import.meta.url), 'utf8'))
const zh = JSON.parse(await readFile(new URL('../locale/ui-zh.json', import.meta.url), 'utf8'))
if (Object.keys(en).sort().join() !== Object.keys(zh).sort().join()) throw new Error('Client locale keys differ')
await mkdir(new URL('../lib/', import.meta.url), { recursive: true })
await writeFile(new URL('../lib/client.js', import.meta.url), source.replace('/*__DICTIONARIES__*/', `const dictionaries = ${JSON.stringify({ en, zh })};`).replace('/*__STYLES__*/', `const styles = ${JSON.stringify(css)};`))
