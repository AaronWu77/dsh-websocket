/** Package lifecycle operations are permitted ONLY inside this allocated scratch CLI profile. */
import assert from 'node:assert/strict'
import { appendFile, readFile, realpath } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
export const name = 'gateway-lifecycle-fixture'
export const inject = ['pluginManager', 'llm']
export function apply(ctx) {
  let checked = false
  ctx.on('agent/request', async (_payload, next) => {
    const request = await next()
    if (checked) return request
    checked = true
    const pc = ctx.get('profileContext')
    const root = await realpath(pc.cwd)
    const expectedParent = await realpath(fileURLToPath(new URL('../../.tmp/', import.meta.url)))
    assert.equal(dirname(root), expectedParent)
    assert.ok(basename(root).startsWith('gateway-lifecycle-'))
    assert.equal(await realpath(pc.dir), join(root, 'profiles', 'headless'))
    const marker = JSON.parse(await readFile(join(root, 'isolated-test-root.json'), 'utf8'))
    assert.equal(marker.token, process.env.GATEWAY_LIFECYCLE_TOKEN)
    assert.equal(marker.root, root)
    const phase = process.env.GATEWAY_LIFECYCLE_PHASE
    const manager = ctx.pluginManager
    const candidate = process.env.GATEWAY_CANDIDATE_BUNDLE ? resolve(process.env.GATEWAY_CANDIDATE_BUNDLE) : fileURLToPath(new URL('../../', import.meta.url))
    const previous = process.env.GATEWAY_PREVIOUS_BUNDLE ? resolve(process.env.GATEWAY_PREVIOUS_BUNDLE) : fileURLToPath(new URL('../../../gpt-ws-gateway/', import.meta.url))
    const report = async (step, detail = {}) => {
      await appendFile(join(root, 'lifecycle.jsonl'), JSON.stringify({ phase, step, ...detail }) + '\n')
    }
    const change = async (step, run, accepted = ['applied', 'restart-required']) => {
      await report(`${step}:start`)
      const result = await run()
      await report(`${step}:result`, { application: result.application, error: result.error?.code, version: result.version, packageExit: result.packageResult?.exitCode })
      assert.ok(accepted.includes(result.application), JSON.stringify(result))
      return result
    }
    await report('active', { hmr: Boolean(ctx.get('hmr')) })
    if (phase === 'upgrade') {
      await change('install-previous', () => manager.installBundle(previous))
      assert.ok(ctx.llm.listProviders().some(row => row.id === 'fixture-ws'))
      await change('remove-previous', () => manager.removeBundle('dsh-websocket'))
      assert.equal(ctx.llm.listProviders().some(row => row.id === 'fixture-ws'), false)
      await change('install-candidate', () => manager.installBundle(candidate))
    } else if (phase === 'rollback') {
      const gateway = ctx.get('websocketGateway')
      assert.ok(gateway, 'fresh process activated the candidate generation')
      const before = await gateway.describe()
      assert.equal(before.providers.find(row => row.id === 'fixture-ws').config.transport, 'auto')
      const probe = await gateway.run({ action: 'verify', provider: 'fixture-ws', model: 'gpt-fixture', allowBillable: true }, 'user')
      assert.equal(probe.websocket, true)
      assert.equal(probe.delta, true)
      assert.equal(probe.state.diagnostics.routes[0].pool.connections, 0)
      await report('loopback-verification', { websocket: probe.websocket, delta: probe.delta, connectionsAfter: 0 })
      await change('remove-before-failed-upgrade', () => manager.removeBundle('dsh-websocket'))
      const manifest = await readFile(join(pc.dir, 'package.json'), 'utf8')
      const lock = await readFile(join(pc.dir, 'pnpm-lock.yaml'), 'utf8')
      await change('rejected-install', () => manager.installBundle(join(root, 'missing-local-bundle')), ['failed'])
      assert.equal(await readFile(join(pc.dir, 'package.json'), 'utf8'), manifest)
      assert.equal(await readFile(join(pc.dir, 'pnpm-lock.yaml'), 'utf8'), lock)
      await report('failed-install-files-restored')
      await change('restore-candidate', () => manager.installBundle(candidate))
    } else if (phase === 'queued-save-dispose') {
      const gateway = ctx.get('websocketGateway')
      assert.ok(gateway)
      const state = await gateway.describe()
      const beforePatch = await readFile(pc.patchPath, 'utf8')
      const entry = ctx.get('configEditor').entries().find(row => row.options.id === 'dsh-websocket')
      assert.ok(entry?.fiber)
      let locked, disposeNow
      const hasLock = new Promise(done => { locked = done })
      const beginDisposal = new Promise(done => { disposeNow = done })
      const teardown = ctx.get('hmr').runExclusive(async () => {
        locked()
        await beginDisposal
        let timer
        try {
          await Promise.race([
            entry.fiber.dispose(),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Gateway disposal waited on a configuration write queued behind its own HMR transaction')), 3000) }),
          ])
        } finally { clearTimeout(timer) }
      })
      await hasLock
      const pending = gateway.run({ action: 'save', provider: 'fixture-ws', revision: state.revision, config: { ...state.providers[0].config, displayName: 'MUST_NOT_BE_SAVED_AFTER_DISPOSAL' } }, 'user').then(() => ({ saved: true }), error => ({ saved: false, code: error.code, message: error.message }))
      disposeNow()
      await teardown
      const outcome = await pending
      assert.equal(outcome.saved, false)
      assert.equal(await readFile(pc.patchPath, 'utf8'), beforePatch, 'a canceled queued save must not write after the plugin unloaded')
      await report('queued-save-rejected-without-deadlock', outcome)
    } else if (phase === 'active-stream-dispose') {
      const gateway = ctx.get('websocketGateway')
      assert.ok(gateway)
      const prepared = await ctx.llm.prepareCall({ provider: 'fixture-ws', model: 'gpt-fixture', maxTokens: 128 })
      const iterator = prepared.stream({ ...prepared.config, sessionId: 'lifecycle-paused', messages: [{ role: 'user', content: [{ type: 'text', text: 'LIFECYCLE_STALL_AFTER_TEXT' }] }] })[Symbol.asyncIterator]()
      for (;;) {
        const chunk = await iterator.next()
        assert.equal(chunk.done, false)
        if (chunk.value.type === 'text-delta') break
      }
      assert.equal((await gateway.describe()).diagnostics.routes[0].pool.busy, 1)
      await change('disable-with-paused-stream', () => manager.setBundleEnabled('dsh-websocket', false), ['applied'])
      assert.equal(ctx.get('websocketGateway'), undefined)
      assert.equal(ctx.llm.listProviders().some(row => row.id === 'fixture-ws'), false)
      const rest = []
      for (;;) { const chunk = await iterator.next(); if (chunk.done) break; rest.push(chunk.value) }
      const finish = rest.findLast(chunk => chunk.type === 'finish')
      assert.equal(finish?.reason.kind, 'aborted')
      await assert.rejects(gateway.run({ action: 'describe' }, 'user'), /stopped/i)
      await report('paused-consumer-aborted-without-hanging')
      await change('enable-after-active-disposal', () => manager.setBundleEnabled('dsh-websocket', true))
    } else if (phase === 'uninstall') {
      assert.ok(ctx.get('websocketGateway'))
      await change('remove-candidate', () => manager.removeBundle('dsh-websocket'))
      assert.equal(ctx.get('websocketGateway'), undefined)
      assert.equal(ctx.llm.listProviders().some(row => row.id === 'fixture-ws'), false)
    } else if (phase === 'confirm-removed') {
      assert.equal(ctx.get('websocketGateway'), undefined)
      assert.equal(ctx.llm.listProviders().some(row => row.id === 'fixture-ws'), false)
      assert.equal((await manager.listBundles()).some(row => row.name === 'dsh-websocket' && row.installed), false)
      const patch = await readFile(pc.patchPath, 'utf8')
      assert.ok(patch.includes('fixture-ws'), 'user configuration survives dependency removal')
    } else throw new Error(`Unrecognized scratch phase: ${phase}`)
    assert.ok(ctx.llm.listProviders().some(row => row.id === 'fixture-source'), 'unrelated adapter survived every lifecycle operation')
    await report('complete')
    return request
  })
}
