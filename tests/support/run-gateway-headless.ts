/** Exercise the built gateway plugin through the supported DSH Headless CLI with loopback inference only. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import type { IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import { access, glob, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'

const TASK = 'Return the offline GPT gateway fixture answer without calling tools.'
const ANSWER = 'GATEWAY_HEADLESS_FIXTURE_OK'
const PROCESS_TIMEOUT_MS = 60_000

type JsonRecord = Record<string, unknown>

function jsonObject(value: unknown): JsonRecord {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value))
  return value as JsonRecord
}

function events(model: string): JsonRecord[] {
  const item = { id: 'msg_gateway_headless', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: ANSWER, annotations: [] }] }
  return [
    { type: 'response.created', sequence_number: 0, response: { id: 'resp_gateway_headless', object: 'response', model, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', sequence_number: 1, output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.output_text.delta', sequence_number: 2, item_id: item.id, output_index: 0, content_index: 0, delta: ANSWER },
    { type: 'response.output_item.done', sequence_number: 3, output_index: 0, item },
    {
      type: 'response.completed', sequence_number: 4,
      response: { id: 'resp_gateway_headless', object: 'response', model, status: 'completed', output: [item], usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } },
    },
  ]
}

async function endpoint(mode: 'websocket' | 'fallback') {
  const upgrades: IncomingMessage[] = []
  const posted: JsonRecord[] = []
  const sent: JsonRecord[] = []
  const errors: unknown[] = []
  const connections: Array<{ socket: WebSocket; closed: Promise<void> }> = []
  const tcp = new Map<Socket, Promise<void>>()
  const websocket = new WebSocketServer({ noServer: true })
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('error', error => errors.push(error))
    request.on('end', () => {
      try {
        assert.equal(request.url, '/v1/responses')
        assert.equal(request.headers.authorization, 'Bearer offline-gateway-key')
        const payload = jsonObject(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        posted.push(payload)
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(events(String(payload.model)).map(event => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
      } catch (error: unknown) {
        errors.push(error)
        response.writeHead(500).end()
      }
    })
  })
  server.on('connection', socket => {
    tcp.set(socket, new Promise(resolve => socket.once('close', () => resolve())))
    socket.on('error', error => errors.push(error))
  })
  server.on('upgrade', (request, socket, head) => {
    upgrades.push(request)
    if (mode === 'fallback') {
      socket.end('HTTP/1.1 404 WebSocket unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
      return
    }
    websocket.handleUpgrade(request, socket, head, ws => {
      const connection = { socket: ws, closed: new Promise<void>(done => ws.once('close', () => done())) }
      connections.push(connection)
      ws.on('error', error => errors.push(error))
      ws.on('message', bytes => {
        try {
          assert.equal(request.url, '/v1/responses')
          assert.equal(request.headers.authorization, 'Bearer offline-gateway-key')
          const payload = jsonObject(JSON.parse(bytes.toString()))
          assert.equal(payload.type, 'response.create')
          sent.push(payload)
          for (const event of events(String(payload.model))) ws.send(JSON.stringify(event))
        } catch (error: unknown) {
          errors.push(error)
          ws.terminate()
        }
      })
    })
  })
  const dispose = async (): Promise<void> => {
    const websocketClosed = new Promise<void>((done, fail) => websocket.close(error => error === undefined ? done() : fail(error)))
    const serverClosed = new Promise<void>((done, fail) => server.close(error => error === undefined ? done() : fail(error)))
    for (const connection of connections) connection.socket.terminate()
    server.closeAllConnections()
    for (const socket of tcp.keys()) socket.destroy()
    await Promise.all([websocketClosed, serverClosed, ...connections.map(connection => connection.closed), ...tcp.values()])
  }
  try {
    await new Promise<void>((done, fail) => {
      server.once('error', fail)
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', fail); done() })
    })
  } catch (error: unknown) {
    await dispose()
    throw error
  }
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')
  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`, upgrades, posted, sent, errors, dispose,
    waitClosed: async () => { await Promise.all(connections.map(connection => connection.closed)) },
  }
}

function environment(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env)) {
    if (/(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|BASE_URL|BASEURL|PROXY)$/i.test(key)
      || /^(?:DSH_PROFILE|DSH_PROFILE_DIR|NODE_OPTIONS)$/i.test(key)) delete env[key]
  }
  return { ...env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', FIXTURE_GATEWAY_KEY: 'offline-gateway-key' }
}

async function runHeadless(bin: string, root: string, overlay: string) {
  const child = spawn(process.execPath, [bin, '--profile', 'headless', '--patch', overlay, TASK], {
    cwd: root, env: environment(root), stdio: 'inherit',
  })
  let deadlineExpired = false
  const failures: Error[] = []
  child.on('error', error => failures.push(error))
  const timer = setTimeout(() => { deadlineExpired = true; child.kill() }, PROCESS_TIMEOUT_MS)
  timer.unref()
  try {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(done => {
      child.once('close', (code, signal) => done({ code, signal }))
    })
    assert.equal(deadlineExpired, false, 'the supported Headless process exited before its deadline without being killed')
    assert.deepEqual(failures, [])
    assert.equal(result.signal, null)
    assert.equal(result.code, 0)
    return result
  } finally {
    clearTimeout(timer)
  }
}

const bin = resolve(process.env['GPT_GATEWAY_DSH_BIN'] ?? fileURLToPath(new URL('../../../../../apps/cli/lib/bin.js', import.meta.url)))
const plugin = fileURLToPath(new URL('../../lib/index.js', import.meta.url))
await access(bin)
await access(plugin)
const tmp = fileURLToPath(new URL('../../.tmp/', import.meta.url))
await mkdir(tmp, { recursive: true })
const ownedParent = await realpath(tmp)

for (const mode of ['websocket', 'fallback'] as const) {
  const root = await mkdtemp(join(ownedParent, 'gateway-headless-'))
  const gateway = await endpoint(mode)
  const started = performance.now()
  try {
    const overlay = join(root, 'gateway-overlay.json')
    const sessionRoot = join(root, 'recorded-sessions')
    await writeFile(overlay, JSON.stringify([
      { id: 'credentials', disabled: false, config: { dshHome: root, watch: false } },
      { id: 'session-persistence-jsonl', config: { root: sessionRoot, compression: 'none' } },
      { id: 'llm-deepseek', disabled: true },
      { id: 'llm-deepseek-account', disabled: true },
      { id: 'agent-default-model', config: { provider: 'fixture-ws', model: 'gpt-fixture' } },
      {
        insert: [{
          id: 'gpt-gateway-built-fixture', name: plugin,
          config: { providers: { 'fixture-ws': {
            baseURL: gateway.baseURL, apiKeyEnv: 'FIXTURE_GATEWAY_KEY', transport: 'auto', reasoning: 'high',
            websocketConnectTimeoutMs: 3_000, closeTimeoutMs: 200, streamIdleTimeoutMs: 5_000,
            retryPolicy: { mode: 'normal', maxRetries: 0 },
            models: [{ id: 'gpt-fixture', contextWindow: 128_000, maxTokens: 1_024, reasoningEfforts: ['high', 'xhigh'] }],
          } } },
        }],
      },
    ]))
    await runHeadless(bin, root, overlay)
    assert.deepEqual(gateway.errors, [])
    assert.ok(gateway.upgrades.length >= 1)
    const payloads = mode === 'websocket' ? gateway.sent : gateway.posted
    assert.ok(payloads.some(payload => JSON.stringify(payload.input).includes(TASK)), 'the actual Headless task reached the gateway')
    assert.ok(payloads.every(payload => payload.model === 'gpt-fixture'))
    for (const payload of payloads) {
      assert.deepEqual(payload.reasoning, { effort: 'high', summary: 'auto' })
      assert.deepEqual(payload.include, ['reasoning.encrypted_content'])
      assert.equal(Object.hasOwn(payload, 'reasoning_effort'), false)
    }
    if (mode === 'websocket') assert.equal(gateway.posted.length, 0)
    else {
      assert.equal(gateway.sent.length, 0)
      assert.equal(gateway.posted.length, gateway.upgrades.length)
    }
    let recordedReasoningHeaders = 0
    for await (const relative of glob('**/session*.jsonl', { cwd: sessionRoot })) {
      const text = await readFile(join(sessionRoot, relative), 'utf8')
      for (const line of text.split('\n')) {
        if (line.trim().length === 0) continue
        const event = jsonObject(JSON.parse(line))
        if (event.type !== 'request/header') continue
        const header = jsonObject(jsonObject(event.data).header)
        const config = jsonObject(header.config)
        if (config.provider !== 'fixture-ws') continue
        assert.equal(config.model, 'gpt-fixture')
        assert.equal(config.reasoningEffort, 'high')
        assert.equal(jsonObject(header.adapterDefaults).reasoningEffort, true)
        recordedReasoningHeaders++
      }
    }
    assert.ok(recordedReasoningHeaders > 0, 'the resolved reasoning default is recorded in the real Session request header')
    await gateway.waitClosed()
    console.log(JSON.stringify({ check: 'built-gateway-real-headless', mode, naturalExit: true, websocketUpgrades: gateway.upgrades.length,
      wsRequests: gateway.sent.length, sseRequests: gateway.posted.length, recordedReasoningHeaders, elapsedMs: Math.round(performance.now() - started) }))
  } finally {
    await gateway.dispose()
    const target = resolve(root)
    assert.equal(dirname(target), ownedParent, 'cleanup remains inside the allocated private test directory')
    assert.ok(basename(target).startsWith('gateway-headless-'))
    await rm(target, { recursive: true, force: true })
  }
}
