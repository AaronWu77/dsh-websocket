/** Runs inside a scratch Loader composition; all credentials and endpoints are synthetic. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { snapshotJsonValue } from '../../../../../packages/util/values/lib/index.js'
export const name = 'gateway-management-fixture'
export const inject = ['websocketGateway', 'tools', 'llm', 'settings', 'loader']
export function apply(ctx) {
  let checked = false
  ctx.on('agent/request', async (_payload, next) => {
    const request = await next()
    if (checked) return request
    checked = true
    const service = ctx.websocketGateway
    const before = await service.describe()
    const source = before.sources.find(row => row.provider === 'fixture-source')
    assert.ok(source?.eligible, JSON.stringify(source))
    const tool = ctx.tools.get('websocket_gateway')
    assert.ok(tool)
    const exec = { signal: new AbortController().signal }
    const initial = await tool.execute({ action: 'describe' }, exec)
    assert.notEqual(snapshotJsonValue(initial), undefined, 'management Tool output must cross the actual DSH lossless JSON boundary')
    assert.equal(initial.revision, before.revision)
    const imported = await tool.execute({ action: 'import', provider: 'fixture-copy', source: 'fixture-source', sourceFingerprint: source.fingerprint, revision: before.revision }, exec)
    assert.ok(imported.providers.some(row => row.id === 'fixture-copy'))
    assert.equal(JSON.stringify(imported).includes('secret-header-value'), false)
    const copy = imported.providers.find(row => row.id === 'fixture-copy')
    await assert.rejects(service.run({ action: 'save', create: true, provider: 'fixture-copy', revision: imported.revision, config: copy.config }, 'user'), /already exists/i)
    assert.equal((await service.describe()).revision, imported.revision)
    assert.equal(copy.config.headersConfigured, true)
    const saved = await tool.execute({ action: 'save', provider: 'fixture-copy', revision: imported.revision, config: { ...copy.config, displayName: 'Changed locally', transport: 'sse', baseURL: copy.config.baseURL + '/other' } }, exec)
    await assert.rejects(service.run({ action: 'merge-models', provider: 'fixture-copy', source: 'fixture-source', sourceFingerprint: source.fingerprint, revision: saved.revision, models: ['gpt-inherited'] }, 'user'), { code: 'endpoint-mismatch' })
    assert.equal(saved.providers.find(row => row.id === 'fixture-copy').config.transport, 'sse')
    await assert.rejects(service.run({ action: 'delete', provider: 'fixture-copy', revision: before.revision }, 'agent'), /changed/i)
    await assert.rejects(tool.execute({ action: 'verify', provider: 'fixture-copy', model: 'gpt-fixture', allowBillable: true }, exec), /owner Settings/)
    await assert.rejects(service.run({ action: 'verify', provider: 'fixture-copy', model: 'gpt-fixture', allowBillable: true }, 'agent'), /Settings/)
    await assert.rejects(service.run({ action: 'credential', provider: 'fixture-copy', key: 'must-not-be-written' }, 'agent'), /owner/)
    const reset = await tool.execute({ action: 'reset', provider: 'fixture-copy' }, exec)
    assert.ok(reset.providers.some(row => row.id === 'fixture-copy'))
    const deleted = await tool.execute({ action: 'delete', provider: 'fixture-copy', revision: saved.revision }, exec)
    assert.equal(deleted.providers.some(row => row.id === 'fixture-copy'), false)
    assert.deepEqual(source.preview.find(row => row.id === 'gpt-inherited'), {
      id: 'gpt-inherited', contextWindow: { value: 1_000_000, source: 'builtin-default' }, maxTokens: { value: 2_048, source: 'route-default' },
    })
    const initialRoute = initial.providers.find(row => row.id === 'fixture-ws').config
    const disabledDiscovery = await tool.execute({ action: 'refresh', provider: 'fixture-ws' }, exec)
    assert.equal(disabledDiscovery.discovery, 'disabled')
    assert.deepEqual(disabledDiscovery.models.map(row => row.id), ['gpt-fixture'])
    const merge = { action: 'merge-models', provider: 'fixture-ws', source: 'fixture-source', sourceFingerprint: source.fingerprint, revision: deleted.revision, models: ['gpt-inherited'] }
    await assert.rejects(service.run(merge, 'agent'), { code: 'user-only' })
    await assert.rejects(service.run({ ...merge, models: ['gpt-inherited', 'gpt-inherited'] }, 'user'), { code: 'invalid-model-selection' })
    await assert.rejects(service.run({ ...merge, models: ['gpt-fixture'] }, 'user'), { code: 'model-conflict' })
    await ctx.settings.update('llm-pi-ai', { providers: { 'fixture-source': { defaultMaxTokens: 4_096 } } })
    const reviewed = await service.describe()
    assert.equal(reviewed.revision, deleted.revision, 'only source configuration changed')
    await assert.rejects(service.run(merge, 'user'), { code: 'source-changed' })
    const currentSource = reviewed.sources.find(row => row.provider === 'fixture-source')
    assert.equal(currentSource.preview.find(row => row.id === 'gpt-inherited').maxTokens.value, 4_096)
    const callerEntry = ctx.fiber.entry
    const callerConfig = structuredClone(callerEntry.options.config)
    assert.equal(callerEntry.options.id, 'gateway-management-fixture')
    const merged = await service.run({ ...merge, sourceFingerprint: currentSource.fingerprint }, 'user')
    assert.deepEqual(callerEntry.options.config, callerConfig)
    const gatewayEntry = [...ctx.loader.entries()].find(entry => entry.options.id === 'gpt-gateway-built-fixture')
    assert.ok(gatewayEntry.options.config.providers['fixture-ws'].models.some(model => model.id === 'gpt-inherited'))
    const { models, ...retained } = merged.providers.find(row => row.id === 'fixture-ws').config
    const { models: original, ...expected } = initialRoute
    assert.deepEqual(retained, expected)
    assert.deepEqual(models, [...original, { id: 'gpt-inherited', name: 'gpt-inherited', input: ['text'], reasoningEfforts: ['high'], contextWindow: 1_000_000, maxTokens: 4_096 }])
    await assert.rejects(service.run({ ...merge, sourceFingerprint: currentSource.fingerprint }, 'user'), { code: 'conflict' })
    const discover = await service.run({ action: 'save', provider: 'fixture-ws', revision: merged.revision, config: { ...retained, models, discover: true } }, 'user')
    const changed = []
    const off = ctx.on('llm/models-updated', provider => changed.push(provider))
    try {
      const refreshed = await service.run({ action: 'refresh', provider: 'fixture-ws', revision: discover.revision }, 'user')
      assert.equal(refreshed.discovery, 'refreshed')
      assert.deepEqual(changed, ['fixture-ws'])
      assert.deepEqual(refreshed.models.map(row => row.id), ['gpt-fixture', 'gpt-inherited', 'gpt-discovered'])
      assert.equal((await ctx.llm.resolveModelInfo('fixture-ws', 'gpt-discovered')).id, 'gpt-discovered')
    } finally { off() }
    for (const output of [initial, imported, saved, reset, deleted, merged]) assert.notEqual(snapshotJsonValue(output), undefined, 'all successful management Tool results must be lossless JSON')
    assert.ok(ctx.llm.listProviders().some(row => row.id === 'fixture-source'))
    await writeFile(join(ctx.get('profileContext').cwd, 'management-ok.json'), JSON.stringify({ imported: true, saved: true, conflictRejected: true, userOnlyDenied: true, reset: true, deleted: true, merged: true }))
    console.log('GATEWAY_MANAGEMENT_FIXTURE_OK')
    return request
  })
}
