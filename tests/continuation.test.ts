/** Exact-prefix continuation and circuit decisions use deterministic data and clocks. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Continuation } from '../src/continuation.ts'
import { Circuit } from '../src/circuit.ts'
const user = (text: string) => ({ role: 'user', content: [{ type: 'input_text', text }] })
const assistant = { type: 'message', id: 'msg_a', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'amber', annotations: [] }] }
const first = { model: 'gpt-fixture', input: [user('你好')], store: false, stream: true }
const completed = { status: 'completed', id: 'resp_a', output: [assistant] }

test('continuation requires the complete prior input and completed output, not a longest common prefix', () => {
  const chain = new Continuation(4096)
  assert.equal(chain.plan(first, true).delta, false)
  assert.equal(chain.commit(first, completed), true)
  const next = { ...first, input: [...first.input, assistant, user('next')] }
  assert.deepEqual(chain.plan(next, true).body, { model: 'gpt-fixture', store: false, previous_response_id: 'resp_a', input: [user('next')] })
  for (const input of [[user('changed'), assistant, user('next')], [...first.input, user('next')], [user('summary'), user('next')], [...first.input, assistant]]) {
    assert.equal(chain.plan({ ...first, input }, true).delta, false)
  }
  assert.equal(chain.plan({ ...next, tools: [{ type: 'function', name: 'new_tool' }] }, true).reason, 'parameters-changed')
  assert.equal(chain.plan(next, false).reason, 'disabled')
  assert.ok(chain.retainedBytes > 0)
  chain.reset(); assert.equal(chain.retainedBytes, 0)
})
const withOutputFields = <T extends Record<string, unknown>>(fields: T) => ({ ...assistant, content: [{ ...assistant.content[0], ...fields }] })

test('only a legal empty output_text logprobs array is ignored in history comparison', () => {
  const chain = new Continuation(4096)
  const emptyLogprobs = withOutputFields({ logprobs: [] })
  const next = { ...first, input: [...first.input, assistant, user('next')] }
  assert.equal(chain.commit(first, { ...completed, output: [emptyLogprobs] }), true)
  assert.equal(chain.plan(next, true).delta, true)
  assert.deepEqual(emptyLogprobs.content[0]!.logprobs, [])
  assert.equal(chain.commit(first, completed), true)
  const uncached = withOutputFields({ logprobs: [] })
  assert.deepEqual(chain.plan({ ...first, input: [...first.input, assistant, uncached] }, true).body.input, [uncached])

  for (const changed of [
    withOutputFields({ logprobs: [{ token: 'amber', logprob: -0.1, bytes: [], top_logprobs: [] }] }),
    withOutputFields({ logprobs: null }),
    withOutputFields({ annotations: [{ type: 'url_citation', url: 'https://example.invalid', title: 'Source', start_index: 0, end_index: 5 }] }),
    withOutputFields({ text: 'other text' }),
    { ...assistant, id: 'msg_b' },
    { ...assistant, phase: 'final_answer' },
    { ...assistant, signature: 'private-signature' },
  ]) {
    assert.equal(chain.commit(first, { ...completed, output: [changed] }), true)
    const plan = chain.plan(next, true)
    assert.equal(plan.reason, 'context-changed')
    assert.deepEqual(plan.body.input, next.input)
    assert.equal(plan.body.previous_response_id, undefined)
  }

  for (const changed of [
    { ...assistant, role: 'user' },
    withOutputFields({ type: 'input_text' }),
    withOutputFields({ text: 42 }),
    withOutputFields({ annotations: undefined }),
  ]) {
    const terminal = { ...changed, content: [{ ...changed.content[0], logprobs: [] }] }
    assert.equal(chain.commit(first, { ...completed, output: [terminal] }), true)
    assert.equal(chain.plan({ ...first, input: [...first.input, changed, user('next')] }, true).reason, 'context-changed')
  }
})

test('continuation comparison reports only the first mismatched section and safe field presence', () => {
  const chain = new Continuation(4096)
  const prior = { ...first, input: Array.from({ length: 6 }, (_, i) => user('prior-' + i)) }
  const output = { ...withOutputFields({ logprobs: [{ token: 'private-logprob' }] }), phase: 'private-phase' }
  assert.equal(chain.commit(prior, { ...completed, output: [output] }), true)
  const replay = { ...assistant, id: 'private-id', 'private-extension': 'private-value' }
  const plan = chain.plan({ ...prior, input: [...prior.input, replay, user('private-suffix')] }, true)
  assert.equal(plan.reason, 'context-changed')
  assert.deepEqual(plan.comparison, {
    kind: 'item-mismatch', inputLength: 8, previousInputLength: 6, previousOutputLength: 1,
    firstDifference: { index: 6, section: 'prior-output', previousType: 'message', currentType: 'message', fields: [
      { name: 'phase', previousPresent: true, currentPresent: false },
      { name: 'content[].logprobs', previousPresent: true, currentPresent: false },
    ] },
  })
  const changedFirst = { type: 'private-type', content: [{ type: 'private-content-type', text: 'private-text', 'private-key': 'private-value' }] }
  const earlier = chain.plan({ ...prior, input: [changedFirst, ...prior.input.slice(1), replay, user('private-suffix')] }, true)
  assert.deepEqual(earlier.comparison?.firstDifference, { index: 0, section: 'prior-input', previousType: 'message', currentType: 'unknown', fields: [
    { name: 'role', previousPresent: true, currentPresent: false },
  ] })
  assert.doesNotMatch(JSON.stringify([plan.comparison, earlier.comparison]), /private-|resp_a|msg_a/)
})

test('continuation comparison distinguishes a truncated prefix from a complete prefix without new input', () => {
  const chain = new Continuation(4096)
  assert.equal(chain.commit(first, completed), true)
  const truncated = chain.plan(first, true)
  assert.equal(truncated.reason, 'context-changed')
  assert.deepEqual(truncated.comparison, {
    kind: 'shorter-history', inputLength: 1, previousInputLength: 1, previousOutputLength: 1,
    firstDifference: { index: 1, section: 'prior-output', previousType: 'message', currentType: 'missing', fields: [
      { name: 'id', previousPresent: true, currentPresent: false },
      { name: 'role', previousPresent: true, currentPresent: false },
      { name: 'status', previousPresent: true, currentPresent: false },
      { name: 'content', previousPresent: true, currentPresent: false },
      { name: 'content[].text', previousPresent: true, currentPresent: false },
      { name: 'content[].annotations', previousPresent: true, currentPresent: false },
    ] },
  })
  const noNewInput = chain.plan({ ...first, input: [...first.input, assistant] }, true)
  assert.equal(noNewInput.reason, 'context-changed')
  assert.deepEqual(noNewInput.comparison, { kind: 'no-new-input', inputLength: 2, previousInputLength: 1, previousOutputLength: 1 })
  assert.equal(chain.plan({ ...first, input: [...first.input, assistant, user('next')], reasoning: { effort: 'high' } }, true).comparison, undefined)
})

test('function-call replay compares parsed arguments and completed-only status; sibling calls are retained', () => {
  const chain = new Continuation(4096)
  const output = [{ type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'read', status: 'completed', arguments: '{ "b":2, "a":1 }' }, { type: 'function_call', id: 'fc_b', call_id: 'call_b', name: 'read', arguments: '{}' }]
  chain.commit(first, { ...completed, output })
  const replay = output.map(({ status: _status, ...item }) => ({ ...item, arguments: item.id === 'fc_a' ? '{"a":1,"b":2}' : '{}' }))
  const results = [{ type: 'function_call_output', call_id: 'call_a', output: 'a' }, { type: 'function_call_output', call_id: 'call_b', output: 'b' }]
  const plan = chain.plan({ ...first, input: [...first.input, ...replay, ...results] }, true)
  assert.equal(plan.delta, true); assert.deepEqual(plan.body.input, results)
  assert.equal(chain.plan({ ...first, input: [...first.input, replay[1], replay[0], ...results] }, true).delta, false)
})
test('reasoning and message phase remain part of the exact context', () => {
  const chain = new Continuation(4096)
  const output = [{ type: 'reasoning', id: 'rs_a', encrypted_content: 'signature', summary: [] }, { ...assistant, phase: 'commentary' }]
  chain.commit(first, { ...completed, output })
  assert.equal(chain.plan({ ...first, input: [...first.input, ...output, user('next')] }, true).delta, true)
  assert.equal(chain.plan({ ...first, input: [...first.input, { ...output[0], encrypted_content: 'changed' }, output[1], user('next')] }, true).delta, false)
})
test('failed, incomplete, malformed, and oversized heads never become continuation parents', () => {
  for (const response of [{ ...completed, status: 'failed' }, { ...completed, status: 'incomplete' }, { ...completed, id: undefined }, { ...completed, output: [{ type: 'unrecognized' }] }]) {
    const chain = new Continuation(4096); assert.equal(chain.commit(first, response), false)
    assert.equal(chain.plan({ ...first, input: [...first.input, assistant, user('next')] }, true).delta, false)
  }
  const tiny = new Continuation(1); assert.equal(tiny.commit(first, completed), false); assert.equal(tiny.retainedBytes, 0)
})
test('SSE successes do not heal WS cooling and expiry permits a single recovery lease', () => {
  let now = 100
  const circuit = new Circuit(2, 1000, () => now)
  circuit.admit().settle('failure'); circuit.admit().settle('failure')
  const sse = circuit.admit(); assert.equal(sse.mode, 'sse'); sse.settle('success'); assert.equal(circuit.failures, 2)
  now = 1100
  const probe = circuit.admit(); assert.equal(probe.mode, 'auto'); assert.equal(circuit.admit().mode, 'sse')
  probe.settle('failure'); assert.equal(circuit.sseUntil, 2100)
  now = 2100
  circuit.admit().settle('success'); assert.equal(circuit.sseUntil, 0); assert.equal(circuit.failures, 0)
  circuit.admit().settle('neutral'); assert.equal(circuit.failures, 0)
})
