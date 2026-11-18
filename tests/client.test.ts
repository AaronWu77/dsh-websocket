/** Component behavior against the emitted factory with a stubbed owner endpoint and Web module table. */
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import vm from 'node:vm'
const rootRequire = createRequire(new URL('../../../../package.json', import.meta.url))
const testRequire = createRequire(rootRequire.resolve('@testing-library/react'))

type Props = Record<string, unknown>
interface Segment { value: string; label: string }

async function createUi(t: TestContext, response: (input: Props) => unknown) {
  const { JSDOM } = rootRequire('jsdom')
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'https://ui.test/' })
  const names = ['window', 'document', 'navigator', 'HTMLElement', 'MutationObserver'] as const
  const originals = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]))
  for (const name of names) Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true })
  const React = testRequire('react')
  const { render, fireEvent, waitFor, within, cleanup } = rootRequire('@testing-library/react')
  const disposers: Array<() => void> = []
  t.after(() => {
    try { cleanup(); for (const dispose of disposers.reverse()) dispose() }
    finally {
      for (const name of names) { const old = originals.get(name); if (old) Object.defineProperty(globalThis, name, old); else Reflect.deleteProperty(globalThis, name) }
      dom.window.close()
    }
  })
  const registry = new Map<string, { options: Props; component: typeof React.Component }>()
  const dictionaries = new Map<string, Record<string, string>>()
  const ctx = {
    effect: (effect: () => (() => void) | void) => { const dispose = effect(); if (dispose) disposers.push(dispose); return dispose },
    locale: { register: (_ns: string, locale: string, dict: Record<string, string>) => { dictionaries.set(locale, dict); return () => dictionaries.delete(locale) }, bind: () => (key: string) => dictionaries.get('zh')?.[key] ?? key },
    slots: {
      inject: (_name: string, effect: () => (() => void)) => { const dispose = effect(); disposers.push(dispose); return dispose },
      register: (options: Props, component: typeof React.Component) => { const id = String(options.name) + ':' + String(options.id); registry.set(id, { options, component }); return () => registry.delete(id) },
    },
  }
  const h = React.createElement
  const primitives = {
    Button: React.forwardRef(({ variant: _variant, children, ...props }: Props, ref: unknown) => h('button', { ...props, type: 'button', ref }, children)),
    SegmentedControl: ({ options, value, label, id, className, disabled, onChange }: { options: Segment[]; value: string; label: string; id: string; className: string; disabled: boolean; onChange: (next: string) => void }) => h('div', { role: 'tablist', 'aria-label': label, className }, options.map(option => h('button', {
      key: option.value, id: id + '-' + option.value, type: 'button', role: 'tab', 'aria-selected': value === option.value,
      'aria-controls': id + '-' + option.value + '-panel', disabled, onClick: () => onChange(option.value),
    }, option.label))),
    Switch: ({ label, disabled, checked, onChange }: { label: string; disabled: boolean; checked: boolean; onChange: (next: boolean) => void }) => h('button', { type: 'button', role: 'switch', 'aria-label': label, 'aria-checked': checked, disabled, onClick: () => onChange(!checked) }),
    Tag: ({ children }: Props) => h('span', null, children),
    Toast: ({ text }: Props) => h('div', { role: 'alert' }, text),
  }
  const browserRequire = (name: string) => {
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    assert.equal(name, 'react')
    return React
  }
  let exports: { apply: (context: typeof ctx) => void } | undefined
  const browserWindow = { __ModuleLoader__: { load: ({ factory }: { factory: (require: typeof browserRequire) => typeof exports }) => { exports = factory(browserRequire) } }, confirm: () => false }
  const factory = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  vm.runInNewContext(factory, { window: browserWindow, document: dom.window.document, URL, AbortController, fetch: () => { throw new Error('UI test must not send network requests') } })
  assert.ok(exports); exports.apply(ctx)
  const entry = registry.get('settings.section:dsh-websocket'); assert.ok(entry)
  const zh = dictionaries.get('zh')!, en = dictionaries.get('en')!
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort())
  const calls: Props[] = []
  const notices: string[] = []
  const ui = render(h(entry.component, { t: (key: string) => zh[key] ?? key, invoke: async (input: Props) => {
    calls.push(input)
    return JSON.parse(JSON.stringify(response(input)))
  }, notify: (text: string) => notices.push(text) }))
  return { dom, React, ui, render, fireEvent, waitFor, within, browserWindow, calls, notices, zh, registry, disposers, cleanup }
}

const config = { displayName: 'Fixture', baseURL: 'https://gateway.test/v1', apiKeyEnv: 'FIXTURE_KEY', transport: 'auto', reuseConnection: true, continuation: true, fallbackAfterFailures: 5, fallbackCooldownMs: 300000, models: [{ id: 'gpt-fixture', contextWindow: 500000, maxTokens: 1024, input: ['text'], reasoningEfforts: ['high'] }], discover: false, discovery: { contextWindow: 500000, maxTokens: 128000, input: ['text'], reasoningEfforts: ['high'], exclude: [], ttlMs: 300000, timeoutMs: 10000 } }
const preview = [
  { id: 'gpt-fixture', contextWindow: { value: 500000, source: 'explicit-model' }, maxTokens: { value: 1024, source: 'route-default' } },
  { id: 'gpt-new', contextWindow: { value: 1000000, source: 'builtin-default' }, maxTokens: { value: 128000, source: 'catalog' } },
]
const saved = { id: 'fixture-ws', config, credential: { configured: true }, sourceChanged: false }
const state = { revision: 'r1', writable: true, sources: [{ provider: 'original', displayName: 'Original', eligible: true, fingerprint: 'source-1', preview }], providers: [saved], diagnostics: { routes: [], requests: [], cleanupFailures: [] } }

test('settings preserve a failed draft, review before writing models and confirm billable verification', async t => {
  const verifyResults = { state, websocket: true, delta: true }
  const { ui, fireEvent, waitFor, within, browserWindow, calls, notices, zh, dom, registry, render, React, disposers, cleanup } = await createUi(t, input => {
    if (input.action === 'save') throw Object.assign(new Error('changed'), { code: 'conflict' })
    return input.action === 'verify' ? verifyResults : state
  })
  const icon = registry.get('settings.section.icon:dsh-websocket'); assert.ok(icon, 'the original plugin owns its icon')
  const glyph = render(React.createElement(icon.component, { size: 22, active: true }))
  const svg = glyph.container.querySelector('svg')!
  assert.equal(svg.getAttribute('width'), '22')
  assert.equal(svg.getAttribute('stroke'), 'currentColor')
  assert.equal(svg.getAttribute('aria-hidden'), 'true')
  assert.equal(svg.querySelectorAll('circle').length, 2)
  assert.equal(svg.querySelectorAll('path').length, 2)
  glyph.unmount()

  await waitFor(() => assert.equal(ui.getByLabelText(zh.displayName!).value, 'Fixture'))
  assert.deepEqual(calls.map(c => c.action), ['describe'])
  fireEvent.click(ui.getByText(zh.changeKey!, { selector: 'summary' }))
  fireEvent.change(ui.getByLabelText(zh.newKey!), { target: { value: 'synthetic-unused-key' } })
  assert.equal(ui.getByRole('button', { name: zh.setKey, exact: true }).disabled, false)
  fireEvent.change(ui.getByLabelText(zh.displayName!), { target: { value: 'Draft retained' } })
  assert.equal(ui.getByRole('button', { name: zh.setKey, exact: true }).disabled, true, 'credential writes never use an unsaved draft')
  fireEvent.change(ui.getByLabelText(zh.transport!), { target: { value: 'sse' } })
  assert.equal(ui.getByText(zh.savedPolicy!, { selector: 'dt' }).nextElementSibling?.textContent, zh.policyAuto)
  assert.equal(ui.getByText(zh.actual!, { selector: 'dt' }).nextElementSibling?.textContent, zh.unverified)
  fireEvent.click(ui.getByRole('button', { name: zh.save, exact: true }))
  await waitFor(() => assert.ok(notices.includes(zh.conflict!)))
  assert.equal(ui.getByLabelText(zh.displayName!).value, 'Draft retained')
  fireEvent.click(ui.getByRole('tab', { name: zh.models, exact: true }))
  assert.equal(ui.getByRole('button', { name: zh.refreshModels, exact: true }).disabled, true)
  assert.ok(ui.getByText(zh.discoveryUnsaved!))
  fireEvent.click(ui.getByRole('button', { name: zh.addModel, exact: true }))
  assert.equal(ui.getAllByLabelText(zh.modelId!).length, 2)
  assert.ok(ui.getByLabelText(zh.modelId!, { selector: 'details[open] input' }))

  const openImport = () => fireEvent.click(ui.getByRole('button', { name: zh.openImport, exact: true }))
  openImport()
  assert.equal(ui.getByLabelText(zh.importTarget!).value, 'fixture-ws')
  fireEvent.change(ui.getByLabelText(zh.source!), { target: { value: 'original' } })
  assert.ok(ui.getByText(zh['explicit-model']!))
  assert.ok(ui.getByText(zh['route-default']!))
  assert.ok(ui.getByText(zh['builtin-default']!))
  assert.ok(ui.getByText(zh.catalog!))
  assert.equal(ui.getByRole('checkbox', { name: /gpt-fixture/ }).disabled, true)
  const merge = ui.getByRole('button', { name: zh.mergeModels, exact: true })
  assert.equal(merge.disabled, true)
  fireEvent.click(ui.getByRole('checkbox', { name: 'gpt-new' }))
  assert.equal(merge.disabled, false)
  assert.equal(calls.some(c => c.action === 'merge-models'), false, 'preview and selection do not write')
  fireEvent.click(merge)
  assert.equal(calls.some(c => c.action === 'merge-models'), false, 'declining a dirty-draft confirmation does not write')
  fireEvent.click(ui.getByRole('button', { name: zh.backToModels, exact: true }))
  assert.equal(dom.window.document.activeElement, ui.getByRole('button', { name: zh.openImport, exact: true }))
  assert.equal(ui.getAllByLabelText(zh.modelId!).length, 2)

  openImport()
  fireEvent.change(ui.getByLabelText(zh.source!), { target: { value: 'original' } })
  fireEvent.click(ui.getByRole('checkbox', { name: 'gpt-new' }))
  browserWindow.confirm = () => true
  fireEvent.click(ui.getByRole('button', { name: zh.mergeModels, exact: true }))
  await waitFor(() => assert.ok(ui.getByRole('button', { name: zh.openImport, exact: true })))
  assert.deepEqual(JSON.parse(JSON.stringify(calls.find(c => c.action === 'merge-models'))), { action: 'merge-models', source: 'original', sourceFingerprint: 'source-1', provider: 'fixture-ws', revision: 'r1', models: ['gpt-new'] })
  assert.ok(ui.getByText(zh.discoveryDisabled!))
  fireEvent.click(ui.getByRole('switch', { name: zh.discover, exact: true }))
  assert.ok(ui.getByText(zh.discoveryUnsaved!))
  assert.equal(ui.getByRole('button', { name: zh.refreshModels, exact: true }).disabled, true)
  assert.equal(calls.some(c => c.action === 'refresh'), false)
  fireEvent.click(ui.getByRole('button', { name: zh.discard, exact: true }))
  fireEvent.click(ui.getByText(zh.modelVerification!, { selector: 'summary' }))
  browserWindow.confirm = () => false
  fireEvent.click(ui.getByRole('button', { name: zh.verify, exact: true }))
  assert.equal(calls.some(c => c.action === 'verify'), false, 'opening verification and declining confirmation do not run inference')
  browserWindow.confirm = () => true
  fireEvent.click(ui.getByRole('button', { name: zh.verify, exact: true }))
  await waitFor(() => assert.ok(ui.getByText(zh.verified!)))
  assert.equal(calls.find(c => c.action === 'verify')?.allowBillable, true)

  openImport()
  fireEvent.change(ui.getByLabelText(zh.importTarget!), { target: { value: '' } })
  fireEvent.change(ui.getByLabelText(zh.source!), { target: { value: 'original' } })
  assert.equal(ui.getByLabelText(zh.target!).value, 'original-ws')
  assert.equal(calls.some(c => c.action === 'import'), false)
  fireEvent.click(ui.getByRole('button', { name: zh.import, exact: true }))
  await waitFor(() => assert.ok(ui.getByRole('button', { name: zh.openImport, exact: true })))
  assert.equal(calls.find(c => c.action === 'import')?.sourceFingerprint, 'source-1')

  fireEvent.click(within(ui.getByRole('complementary', { name: zh.routes })).getByRole('button', { name: zh.add, exact: true }))
  const routeId = ui.getByLabelText(zh.id!)
  fireEvent.change(routeId, { target: { value: 'fixture-ws' } })
  assert.equal(routeId.readOnly, false, 'typing an existing id must not replace the new-route draft')
  assert.ok(ui.getByText(zh.routeConflict!))
  assert.equal(ui.getByRole('button', { name: zh.save, exact: true }).disabled, true)
  fireEvent.change(routeId, { target: { value: 'another-ws' } })
  assert.equal(ui.queryByText(zh.routeConflict!), null)
  cleanup()
  for (const dispose of disposers.reverse()) dispose()
  disposers.length = 0
  assert.equal(registry.size, 0)
  assert.equal(dom.window.document.head.querySelectorAll('style').length, 0)
})

const ws = { transport: 'websocket', delta: true, reused: true, requestBytes: 10, fullBytes: 30, sentReasoningEffort: 'high', maxOutputTokens: 1024 }
const sse = { transport: 'sse', delta: false, reused: false, requestBytes: 30, fullBytes: 30 }
const request = (at: number, model: string, fields: Props = {}) => ({ id: model, provider: 'fixture-ws', model, outcome: 'success', startedAt: at * 1000, attempts: [ws], ...fields })

test('recent requests default to five requests across gateways and summarize the actual last send', async t => {
  const comparison = { kind: 'item-mismatch', inputLength: 8, previousInputLength: 6, previousOutputLength: 1, firstDifference: { index: 6, section: 'prior-output', previousType: 'message', currentType: 'message', fields: [{ name: 'phase', previousPresent: true, currentPresent: false }] } }
  const requests = [
    request(0, 'gpt-oldest'), request(7, 'gpt-title', { purpose: 'session-title' }),
    request(3, 'gpt-sse', { attempts: [sse], outcome: 'error', code: 'UPSTREAM_SERVER_ERROR', providerErrorCode: 'server_error' }), request(5, 'gpt-rebuild', { requestedReasoningEffort: 'high', usage: { inputTokens: 0, outputTokens: 21, cacheReadTokens: 88_580 }, attempts: [ws, { ...ws, delta: false, requestBytes: 1_520_435, resetReason: 'context-changed', continuationComparison: comparison }] }),
    request(8, 'gpt-other-route', { provider: 'other-ws' }), request(1, 'gpt-excluded'),
    request(4, 'gpt-fallback', { attempts: [{ ...sse, fallbackReason: 'TRANSPORT' }] }),
    request(2, 'gpt-include'), request(6, 'gpt-latest', { purpose: 'agent' }),
  ]
  const { ui, fireEvent, waitFor, within, calls, zh } = await createUi(t, () => ({ ...state, providers: [saved, { ...saved, id: 'other-ws' }], diagnostics: { ...state.diagnostics, requests } }))
  await waitFor(() => assert.equal(ui.getByLabelText(zh.displayName!).value, 'Fixture'))
  fireEvent.click(ui.getByRole('tab', { name: zh.recent, exact: true }))
  assert.equal(ui.queryByRole('complementary', { name: zh.routes }), null)
  const container: HTMLElement = ui.container
  const cards = () => [...container.querySelectorAll<HTMLElement>('.ws-request > summary')]
  const models = () => cards().map(card => card.querySelector('.ws-request-model')?.textContent)
  const options = ui.getByText(zh.requestOptions!, { selector: 'summary' })
  assert.equal((options.parentElement as HTMLDetailsElement).open, false)
  assert.deepEqual(models(), ['gpt-other-route', 'gpt-title', 'gpt-latest', 'gpt-rebuild', 'gpt-fallback'])
  assert.ok(cards()[1]?.textContent?.includes(zh.titleRequest!))
  fireEvent.click(options)
  assert.equal((options.parentElement as HTMLDetailsElement).open, true)
  assert.equal(ui.getByLabelText(zh.filterRoute!).value, '')
  assert.equal(ui.getByRole('checkbox', { name: zh.includeAuxiliary, exact: true }).checked, true)
  fireEvent.change(ui.getByLabelText(zh.filterRoute!), { target: { value: 'fixture-ws' } })
  fireEvent.click(ui.getByRole('checkbox', { name: zh.includeAuxiliary, exact: true }))
  assert.deepEqual(models(), ['gpt-latest', 'gpt-rebuild', 'gpt-fallback', 'gpt-sse', 'gpt-include'])
  const [latest, rebuild, fallback, direct] = cards()
  assert.match(latest!.textContent!, new RegExp(zh.deltaBadge!))
  assert.match(rebuild!.textContent!, new RegExp(zh.fullBadge!))
  assert.doesNotMatch(rebuild!.textContent!, new RegExp(zh.deltaBadge!))
  assert.match(fallback!.textContent!, /WS → SSE/u)
  assert.doesNotMatch(direct!.textContent!, /WS → SSE/u)
  assert.match(rebuild!.textContent!, /1\.45 MiB/u)
  assert.deepEqual([...rebuild!.querySelectorAll('.ws-metric')].map(item => item.textContent), ['Input 0', 'Output 21', 'Cache W —', 'Cache R 88.58K'])
  fireEvent.click(rebuild)
  const detail = within(rebuild!.parentElement!)
  assert.equal(detail.getByText(zh.requestedReasoningEffort!, { selector: 'dt' }).nextElementSibling?.textContent, 'high')
  assert.equal(detail.getByText(zh.changedFields!, { selector: 'dt' }).nextElementSibling?.textContent, 'phase (' + zh.fieldPresent + ' → ' + zh.fieldAbsent + ')')
  assert.equal(detail.getAllByText(zh.sentReasoningEffort!, { selector: 'dt' }).length, 2)
  fireEvent.click(direct)
  const outcome = within(direct!.parentElement!).getByText(zh.outcome!, { selector: 'dt' }).nextElementSibling
  assert.match(outcome?.textContent ?? '', /UPSTREAM_SERVER_ERROR · server_error/u)
  fireEvent.click(fallback)
  assert.equal(within(fallback!.parentElement!).getByText(zh.fallbackReason!, { selector: 'dt' }).nextElementSibling?.textContent, 'TRANSPORT')
  fireEvent.change(ui.getByLabelText(zh.filterRoute!), { target: { value: '' } })
  fireEvent.click(ui.getByRole('checkbox', { name: zh.includeAuxiliary, exact: true }))
  assert.deepEqual(models(), ['gpt-other-route', 'gpt-title', 'gpt-latest', 'gpt-rebuild', 'gpt-fallback'])
  const refresh = ui.getByRole('button', { name: zh.refreshRequests, exact: true })
  await waitFor(() => assert.equal(refresh.disabled, false))
  fireEvent.click(refresh)
  await waitFor(() => assert.equal(calls.length, 3))
  assert.deepEqual(calls.map(c => c.action), ['describe', 'describe', 'describe'])
})
