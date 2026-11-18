/** Import parser and privacy checks over explicit, schema-materialized provider declarations. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceCandidate } from '../src/management.ts'
import { Config, resolveRoutes } from '../src/config.ts'
const source = () => ({ api: 'openai-responses', baseURL: 'http://127.0.0.1:1/v1', apiKeyEnv: 'SOURCE_KEY', headers: { 'x-custom-secret': 'must-not-leak' }, defaultInput: ['text', 'image'], compat: { chatTemplateKwargs: {}, chatTemplateArgs: {} }, modelOverrides: {}, models: [{ id: 'gpt-fixture', name: 'Fixture', contextWindow: 500000, maxTokens: 1024, input: [], compat: { chatTemplateKwargs: {}, chatTemplateArgs: {} }, reasoningEfforts: { high: 'high', xhigh: 'xhigh' } }, { id: 'deepseek-example', contextWindow: 1, maxTokens: 1 }] })
test('source import keeps the model identity, credential reference and headers on Host but not in its view', () => {
  const result = sourceCandidate('source', source())
  assert.equal(result.view.eligible, true)
  assert.equal(result.config?.apiKeyEnv, 'SOURCE_KEY')
  assert.deepEqual(result.config?.models?.map(m => m.id), ['gpt-fixture'])
  assert.deepEqual(result.config?.models?.[0]?.input, ['text', 'image'])
  assert.equal(result.config?.headers?.['x-custom-secret'], 'must-not-leak')
  assert.equal(JSON.stringify(result.view).includes('must-not-leak'), false)
  assert.equal(result.view.draft?.headersConfigured, true)
  assert.notEqual(sourceCandidate('source', { ...source(), headers: {} }).view.fingerprint, result.view.fingerprint)
})
test('unsupported protocol, proxies, custom compat and renamed reasoning efforts are not silently converted', () => {
  for (const patch of [{ api: 'openai-completions' }, { proxyUrl: 'http://proxy.invalid' }, { compat: { supportsDeveloperRole: false } }, { modelOverrides: { 'gpt-fixture': { maxTokens: 5 } } }, { models: [{ id: 'gpt-fixture', contextWindow: 100, maxTokens: 10, reasoningEfforts: { high: 'ultra' } }] }]) {
    assert.equal(sourceCandidate('source', { ...source(), ...patch }).view.eligible, false)
  }
})
test('unbounded or unsafe retry policies are rejected before route registration', () => {
  for (const retryPolicy of [{ mode: 'always' as const }, ...['OUTCOME_UNKNOWN', 'UPSTREAM_SERVER_ERROR', 'UPSTREAM_RATE_LIMIT', 'AUTH'].map(code => ({ mode: 'normal' as const, retryableCodes: [code] }))]) {
    const declaration = Config({ providers: { fixture: { baseURL: 'http://127.0.0.1:1/v1', apiKeyEnv: 'KEY', models: [{ id: 'gpt-fixture', contextWindow: 100, maxTokens: 10 }], retryPolicy } } })
    assert.throws(() => resolveRoutes(declaration), /finite retries/)
  }
})

test('preview resolves and identifies explicit, catalog, route and built-in capacities', () => {
  const configured = { ...source(), models: [{ id: 'gpt-fixture', contextWindow: 200_000 }] }
  const inherited = sourceCandidate('source', { ...configured, defaultMaxTokens: 96_000 })
  assert.deepEqual(inherited.view.preview, [{ id: 'gpt-fixture', contextWindow: { value: 200_000, source: 'explicit-model' }, maxTokens: { value: 96_000, source: 'route-default' } }])
  const builtIn = sourceCandidate('source', { ...configured, defaultMaxTokens: 128_000 }, configured)
  assert.deepEqual(builtIn.view.preview?.[0]?.maxTokens, { value: 128_000, source: 'builtin-default' })
  assert.notEqual(builtIn.view.fingerprint, sourceCandidate('source', { ...configured, defaultMaxTokens: 128_000 }).view.fingerprint)
  const catalog = sourceCandidate('openai', { ...configured, defaultMaxTokens: 96_000, models: [{ id: 'gpt-5.4', reasoningEfforts: false }] })
  assert.deepEqual(catalog.view.preview, [{ id: 'gpt-5.4', contextWindow: { value: 272_000, source: 'catalog' }, maxTokens: { value: 128_000, source: 'catalog' } }])
})

test('invalid capacity and duplicated IDs identify the affected model without a draft', () => {
  const malformed = sourceCandidate('source', { ...source(), models: [{ id: 'gpt-bad', maxTokens: 0 }] }).view
  assert.deepEqual([malformed.eligible, malformed.reason, malformed.model, malformed.field, malformed.draft], [false, 'model-metadata-required', 'gpt-bad', 'maxTokens', undefined])
  const repeated = sourceCandidate('source', { ...source(), models: [{ id: 'gpt-bad' }, { id: 'gpt-bad' }] }).view
  assert.deepEqual([repeated.eligible, repeated.reason, repeated.model, repeated.draft], [false, 'duplicate-model', 'gpt-bad', undefined])
})
