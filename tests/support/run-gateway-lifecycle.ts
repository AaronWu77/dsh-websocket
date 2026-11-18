/** Install/upgrade/failure-rollback/uninstall in a guarded scratch profile, never the running GUI. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { Socket } from 'node:net'
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'
const bin = resolve(process.env['GPT_GATEWAY_DSH_BIN'] ?? fileURLToPath(new URL('../../../../../apps/cli/lib/bin.js', import.meta.url)))
const tmp = fileURLToPath(new URL('../../.tmp/', import.meta.url))
await mkdir(tmp, { recursive: true })
const root = await mkdtemp(join(await realpath(tmp), 'gateway-lifecycle-'))
const token = randomUUID()
await writeFile(join(root, 'isolated-test-root.json'), JSON.stringify({ root, token }))
const sockets = new Set<Socket>(), peers = new Set<WebSocket>(), closed: Promise<void>[] = []
let sequence = 0, wsRequests = 0, sseRequests = 0
function events(payload: Record<string, unknown>, memory: { token?: string }) {
  const serialized = JSON.stringify(payload.input)
  const match = /Remember this token exactly: (check-[0-9a-f-]+)/.exec(serialized)
  if (match) memory.token = match[1]
  const text = match ? 'OK' : serialized.includes('Return the exact token') ? memory.token ?? 'missing' : 'GATEWAY_LIFECYCLE_OK'
  const n = ++sequence
  const item = { type: 'message', id: `msg_${n}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }
  const result = [
    { type: 'response.created', response: { id: `resp_${n}`, model: payload.model, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: text },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: `resp_${n}`, model: payload.model, status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
  ]
  return serialized.includes('LIFECYCLE_STALL_AFTER_TEXT') ? result.slice(0, 3) : result
}
const wss = new WebSocketServer({ noServer: true })
const server = createServer((req, res) => {
  const buffers: Buffer[] = []; req.on('data', value => buffers.push(value)); req.on('end', () => {
    assert.equal(req.url, '/v1/responses'); assert.equal(req.headers.authorization, 'Bearer offline-lifecycle-key')
    const payload = JSON.parse(Buffer.concat(buffers).toString()) as Record<string, unknown>; sseRequests++
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(events(payload, {}).map(event => `data: ${JSON.stringify(event)}\n\n`).join(''))
  })
})
server.on('connection', socket => { sockets.add(socket); closed.push(new Promise<void>(done => socket.once('close', done))) })
server.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, peer => {
  const memory: { token?: string } = {}; peers.add(peer); closed.push(new Promise<void>(done => peer.once('close', done)))
  peer.on('message', data => { wsRequests++; for (const event of events(JSON.parse(data.toString()) as Record<string, unknown>, memory)) peer.send(JSON.stringify(event)) })
}))
await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
const address = server.address(); assert.ok(address && typeof address === 'object')
const baseURL = `http://127.0.0.1:${address.port}/v1`
const profileDir = join(root, 'profiles', 'headless')
await mkdir(profileDir, { recursive: true })
// The OpenAI-only fixture must never approve unrelated dependency install scripts.
// Pin explicit denials in this newly allocated test profile; undecided new scripts still stop installation.
await writeFile(join(profileDir, 'pnpm-workspace.yaml'), JSON.stringify({ packages: [], autoInstallPeers: false, strictPeerDependencies: true, peerDependencyRules: { ignoreMissing: ['react', 'react-dom'] }, allowBuilds: { '@google/genai@2.21.0': false, 'protobufjs@7.6.6': false } }))
await writeFile(join(profileDir, 'cordis.patch.yml'), JSON.stringify([
  { id: 'hmr', disabled: false },
  { id: 'credentials', disabled: false, config: { dshHome: root, watch: false } },
  { id: 'session-persistence-jsonl', config: { root: join(root, 'sessions'), compression: 'none' } },
  { id: 'llm-deepseek', disabled: true }, { id: 'llm-deepseek-account', disabled: true },
  { id: 'llm-pi-ai', config: { providers: { 'fixture-source': { api: 'openai-responses', baseURL, apiKeyEnv: 'FIXTURE_GATEWAY_KEY', models: [{ id: 'gpt-fixture', contextWindow: 128000, maxTokens: 1024 }] } } } },
  { id: 'agent-default-model', config: { provider: 'fixture-source', model: 'gpt-fixture' } },
  { insert: [{ id: 'gateway-lifecycle-fixture', name: new URL('./lifecycle-fixture.mjs', import.meta.url).href }] },
  { id: 'dsh-websocket', name: 'dsh-websocket', config: { providers: { 'fixture-ws': { baseURL, apiKeyEnv: 'FIXTURE_GATEWAY_KEY', transport: 'auto', closeTimeoutMs: 200, streamIdleTimeoutMs: 5000, models: [{ id: 'gpt-fixture', contextWindow: 128000, maxTokens: 1024 }] } } } },
]))
const allPhases = ['upgrade', 'rollback', 'queued-save-dispose', 'active-stream-dispose', 'uninstall', 'confirm-removed']
const phases = process.env['GATEWAY_LIFECYCLE_TEST_PHASES']?.split(',') ?? allPhases
assert.ok(phases.every(phase => allPhases.includes(phase)))
try {
  for (const phase of phases) {
    const env = { ...process.env }
    for (const key of Object.keys(env)) if (/(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|BASE_URL|BASEURL|PROXY)$/i.test(key) || /^(?:DSH_PROFILE|DSH_PROFILE_DIR|NODE_OPTIONS)$/i.test(key)) delete env[key]
    Object.assign(env, { DSH_HOME: root, DSH_TELEMETRY_DISABLED: '1', FIXTURE_GATEWAY_KEY: 'offline-lifecycle-key', GATEWAY_LIFECYCLE_TOKEN: token, GATEWAY_LIFECYCLE_PHASE: phase, UV_THREADPOOL_SIZE: '1' })
    const child = spawn(process.execPath, [bin, '--profile', 'headless', 'Return GATEWAY_LIFECYCLE_OK without calling tools.'], { cwd: root, env, stdio: 'inherit' })
    let expired = false
    const timer = setTimeout(() => { expired = true; child.kill() }, 180000)
    timer.unref()
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, fail) => { child.once('error', fail); child.once('close', (code, signal) => done({ code, signal })) }).finally(() => clearTimeout(timer))
    assert.equal(expired, false, `${phase} exited naturally`); assert.equal(result.signal, null); assert.equal(result.code, 0, phase)
    const rows = (await readFile(join(root, 'lifecycle.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    assert.ok(rows.some(row => row.phase === phase && row.step === 'active' && row.hmr === true), 'the real HMR profile activated the fixture')
    assert.ok(rows.some(row => row.phase === phase && row.step === 'complete'), `${phase} actually completed, not merely a zero exit with an inactive plugin`)
    console.log(JSON.stringify({ check: 'isolated-package-lifecycle', phase, naturalExit: true, root }))
  }
  assert.equal(wsRequests, (phases.includes('rollback') ? 2 : 0) + (phases.includes('active-stream-dispose') ? 1 : 0))
  console.log(JSON.stringify({ check: 'isolated-package-lifecycle-complete', phases, wsRequests, sseRequests, liveProfileChanged: false, evidence: join(root, 'lifecycle.jsonl') }))
} finally {
  const httpClosed = new Promise<void>(done => server.close(() => done())), websocketClosed = new Promise<void>(done => wss.close(() => done()))
  for (const peer of peers) peer.terminate(); for (const socket of sockets) socket.destroy()
  await Promise.all([httpClosed, websocketClosed, ...closed])
  // Preserve the scratch composition, logs and marker so every package operation can be audited.
}
