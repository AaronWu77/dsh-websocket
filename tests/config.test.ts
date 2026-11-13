/** Configuration checks for explicitly adopted API-key GPT gateway routes. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { Config, resolveRoutes } from '../src/config.ts'

function declaration() {
  return {
    providers: {
      'fixture-ws': {
        displayName: 'Fixture gateway',
        baseURL: 'http://127.0.0.1:8080/v1',
        apiKeyEnv: 'FIXTURE_GATEWAY_KEY',
        headers: { 'x-fixture-route': 'fixture-ws' },
        models: [{ id: 'gpt-fixture', contextWindow: 32_000, maxTokens: 512 }],
      },
    },
  }
}

function invalidConfig(error: unknown): boolean {
  assert.ok(error instanceof LlmError)
  assert.equal(error.code, 'INVALID_CONFIG')
  return true
}

test('an empty configuration registers no model routes', () => {
  assert.equal(resolveRoutes(Config({})).size, 0)
})

test('schema defaults retain auto transport and the existing finite retry policy', () => {
  const routes = resolveRoutes(Config(declaration()))
  const route = routes.get('fixture-ws')
  assert.ok(route)
  assert.equal(route.config.transport, 'auto')
  assert.equal(route.config.reasoning, undefined)
  assert.equal(route.profile.reasoning, undefined)
  assert.equal(route.config.websocketConnectTimeoutMs, 10_000)
  assert.equal(route.config.closeTimeoutMs, 2_000)
  assert.equal(route.config.fallbackAfterFailures, 5)
  assert.equal(route.config.fallbackCooldownMs, 300_000)
  assert.equal(route.profile.apiKeyEnv, 'FIXTURE_GATEWAY_KEY')
  assert.equal(route.profile.retryPolicy.mode, 'normal')
  if (route.profile.retryPolicy.mode !== 'normal') assert.fail('expected a finite retry policy')
  assert.equal(route.profile.retryPolicy.maxRetries, 5)
  assert.deepEqual(route.models.map(model => ({ id: model.id, api: model.api, provider: model.provider, input: model.input, reasoning: model.reasoning })), [
    { id: 'gpt-fixture', api: 'openai-responses', provider: 'fixture-ws', input: ['text'], reasoning: false },
  ])
})

test('a resolved route detaches endpoint, headers and model metadata from the input', () => {
  const validated = Config(declaration())
  const routes = resolveRoutes(validated)
  validated.providers['fixture-ws']!.baseURL = 'https://changed.example/v1'
  validated.providers['fixture-ws']!.headers['x-fixture-route'] = 'changed'
  validated.providers['fixture-ws']!.models[0]!.id = 'gpt-changed'
  const route = routes.get('fixture-ws')
  assert.ok(route)
  assert.equal(route.config.baseURL, 'http://127.0.0.1:8080/v1')
  assert.equal(route.profile.headers?.['x-fixture-route'], 'fixture-ws')
  assert.equal(route.models[0]?.id, 'gpt-fixture')
})

test('explicit non-GPT model ids are rejected before registration', () => {
  for (const model of ['claude-fixture', 'deepseek-fixture', 'mimo-fixture']) {
    const raw = declaration()
    raw.providers['fixture-ws'].models[0]!.id = model
    assert.throws(() => resolveRoutes(Config(raw)), invalidConfig)
  }
})

test('an OpenAI-namespaced GPT id remains an explicitly declared Responses model', () => {
  const raw = declaration()
  raw.providers['fixture-ws'].models[0]!.id = 'openai/gpt-fixture'
  assert.equal(resolveRoutes(Config(raw)).get('fixture-ws')?.models[0]?.id, 'openai/gpt-fixture')
})

test('empty and duplicate model declarations are rejected before registration', () => {
  const empty = declaration()
  empty.providers['fixture-ws'].models = []
  assert.throws(() => resolveRoutes(Config(empty)), invalidConfig)
  const duplicate = declaration()
  duplicate.providers['fixture-ws'].models.push({ ...duplicate.providers['fixture-ws'].models[0]! })
  assert.throws(() => resolveRoutes(Config(duplicate)), invalidConfig)
})

test('gateway URLs cannot contain alternate protocols, credentials, queries or fragments', () => {
  for (const baseURL of [
    'ws://localhost/v1',
    'file:///responses',
    'https://user:password@example.com/v1',
    'https://example.com/v1?token=fixture',
    'https://example.com/v1#responses',
  ]) {
    const raw = declaration()
    raw.providers['fixture-ws'].baseURL = baseURL
    assert.throws(() => resolveRoutes(Config(raw)), invalidConfig)
  }
})

test('duplicate input and effort capabilities are rejected rather than silently normalized', () => {
  const duplicateInput = Config(declaration())
  duplicateInput.providers['fixture-ws']!.models[0]!.input = ['text', 'text']
  assert.throws(() => resolveRoutes(duplicateInput), invalidConfig)
  const duplicateEffort = Config(declaration())
  duplicateEffort.providers['fixture-ws']!.models[0]!.reasoningEfforts = ['high', 'high']
  assert.throws(() => resolveRoutes(duplicateEffort), invalidConfig)
})

test('the image offload quantum cannot exceed the retained-image limit', () => {
  const validated = Config(declaration())
  validated.providers['fixture-ws']!.imageOffloadCountQuantum = 11
  validated.providers['fixture-ws']!.maxRequestImages = 10
  assert.throws(() => resolveRoutes(validated), invalidConfig)
})

test('unsupported proxy settings are rejected instead of silently using a direct route', () => {
  const topLevel = { ...declaration(), proxyUrl: 'http://127.0.0.1:7890' }
  assert.throws(() => resolveRoutes(Config(topLevel)), invalidConfig)
  const gateway = declaration()
  Object.assign(gateway.providers['fixture-ws'], { enableProxy: true, proxyUrl: 'http://127.0.0.1:7890' })
  assert.throws(() => resolveRoutes(Config(gateway)), invalidConfig)
})

test('unsupported model fields are rejected instead of discarding capability settings', () => {
  const raw = declaration()
  Object.assign(raw.providers['fixture-ws'].models[0]!, { reasoningEffort: 'high' })
  assert.throws(() => resolveRoutes(Config(raw)), invalidConfig)
})

test('an optional reasoning default is retained only when every adopted model supports it', () => {
  for (const reasoning of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const) {
    const raw = declaration()
    Object.assign(raw.providers['fixture-ws'], { reasoning })
    Object.assign(raw.providers['fixture-ws'].models[0]!, { reasoningEfforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] })
    const route = resolveRoutes(Config(raw)).get('fixture-ws')
    assert.equal(route?.profile.reasoning, reasoning)
    raw.providers['fixture-ws'].models.push({ id: 'gpt-no-reasoning', contextWindow: 32_000, maxTokens: 512 })
    assert.throws(() => resolveRoutes(Config(raw)), invalidConfig)
  }
})

test('reasoning defaults validate the enabled discovery template but ignore an unused template', () => {
  const raw = declaration()
  Object.assign(raw.providers['fixture-ws'], { reasoning: 'xhigh', discover: true, discovery: { reasoningEfforts: ['high'] } })
  Object.assign(raw.providers['fixture-ws'].models[0]!, { reasoningEfforts: ['high', 'xhigh'] })
  assert.throws(() => resolveRoutes(Config(raw)), invalidConfig)
  Object.assign(raw.providers['fixture-ws'], { discovery: { reasoningEfforts: ['high', 'xhigh'] } })
  assert.equal(resolveRoutes(Config(raw)).get('fixture-ws')?.profile.reasoning, 'xhigh')
  Object.assign(raw.providers['fixture-ws'], { discover: false, discovery: { reasoningEfforts: ['high'] } })
  assert.equal(resolveRoutes(Config(raw)).get('fixture-ws')?.profile.reasoning, 'xhigh')
})

test('off does not add a reasoning capability to a model that does not advertise one', () => {
  const raw = declaration()
  Object.assign(raw.providers['fixture-ws'], { reasoning: 'off' })
  assert.equal(resolveRoutes(Config(raw)).get('fixture-ws')?.profile.reasoning, 'off')
  Object.assign(raw.providers['fixture-ws'].models[0]!, { reasoningEfforts: ['high'] })
  assert.throws(() => resolveRoutes(Config(raw)), invalidConfig)
})

test('unknown reasoning defaults fail schema validation', () => {
  const raw = declaration()
  Object.assign(raw.providers['fixture-ws'], { reasoning: 'unsupported' })
  assert.throws(() => resolveRoutes(Config(raw)))
})
