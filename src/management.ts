/** Owner-only configuration and diagnostics; neither listing nor importing generates model output. */
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-config-editor'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-settings'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { GenerateOptions, RequestMessage, StreamChunk } from '@deepseek-ai/dsh-llm'
import { randomUUID } from 'node:crypto'
import { Config, resolveRoutes } from './config.ts'
import type { GatewayConfig, GatewayInput } from './config.ts'
import { sameEndpoint, sourceCandidate } from './model-import.ts'
import type { Source } from './model-import.ts'
import { object, fingerprint } from './continuation.ts'
import type { JsonObject } from './continuation.ts'
import type { GatewayAdapter } from './adapter.ts'

export class ManagementFailure extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'ManagementFailure' }
}
export { sourceCandidate } from './model-import.ts'

export interface ManagementOptions {
  current: () => Record<string, GatewayConfig>
  adapter: GatewayAdapter
  apply: () => void
}
/** A single implementation is shared by the owner UI and the optional management tool. */
export class GatewayManagement extends Service {
  private readonly lifetime = new AbortController()
  constructor(private readonly ownerContext: Context, private readonly options: ManagementOptions) {
    super(ownerContext, 'websocketGateway')
    // A queued configEditor write may be waiting behind the HMR transaction disposing us.
    // Abort/fence that write instead of awaiting it and deadlocking the same transaction.
    // The adapter's own disposer drains owned streams, discovery work and connections.
    ownerContext.effect(() => () => { this.lifetime.abort() }, 'dsh-websocket: abort management operations')
  }
  private sources(): Source[] {
    const settings = this.ctx.get('settings')
    if (!settings) return []
    const descriptors = settings.describe()
    const rows = this.ctx.llm.listConfigurableProviders()
    const entries = this.ctx.get('configEditor')?.configuration() ?? []
    const local = this.options.current()
    return rows.flatMap(row => {
      const descriptor = descriptors.find(d => d.ns === row.settingsNs)
      let value: unknown = descriptor?.value
      let declarations: unknown = entries.find(item => item.entry.options.id === row.settingsNs)?.entry.options.config ?? {}
      for (const key of row.settingsPath) {
        value = object(value)?.[key]
        declarations = object(declarations)?.[key]
      }
      if (!value || Object.hasOwn(local, row.provider)) return []
      return [sourceCandidate(row.provider, value, declarations ?? {}, row.declared === false)]
    })
  }
  private revision(): string { return fingerprint(this.options.current()) }
  private safeConfig(config: GatewayConfig): JsonObject {
    const { headers, ...safe } = config
    return { ...structuredClone(safe), headersConfigured: Object.keys(headers).length > 0 }
  }
  /** Read redacted configuration and bounded in-memory diagnostics; no inference or discovery I/O. */
  async describe() {
    const sources = this.sources().map(source => source.view)
    return {
      revision: this.revision(), writable: Boolean(this.ownerContext.get('configEditor') && this.ownerContext.fiber.entry), sources,
      providers: await Promise.all(Object.entries(this.options.current()).map(async ([id, config]) => ({
        id, config: this.safeConfig(config), credential: await this.ctx.credentials.describe(credentialRef(config.apiKeyEnv)),
        sourceChanged: config.sourceProvider ? sources.find(source => source.provider === config.sourceProvider)?.fingerprint !== config.sourceFingerprint : false,
      }))), diagnostics: this.options.adapter.diagnostics(),
    }
  }
  private async write(expected: unknown, change: (current: Record<string, GatewayConfig>) => Record<string, GatewayConfig>, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    // A traced service's ctx can belong to the requesting fiber, not the route configuration.
    const editor = this.ownerContext.get('configEditor'), entry = this.ownerContext.fiber.entry
    if (!editor || !entry) throw new ManagementFailure('read-only', 'This profile cannot save gateway configuration.')
    if (typeof expected !== 'string') throw new ManagementFailure('revision-required', 'Reload the page before saving.')
    await editor.edit(entry, current => {
      signal.throwIfAborted()
      if (expected !== this.revision()) throw new ManagementFailure('conflict', 'Gateway settings changed. Reload before saving again.')
      const providers = change(structuredClone(this.options.current()))
      const next = Config({ providers })
      resolveRoutes(next)
      const owned = new Set(Object.keys(this.options.current()))
      if (this.ctx.llm.listProviders().some(row => !owned.has(row.id) && providers[row.id])) throw new ManagementFailure('route-conflict', 'This provider id is already owned by another adapter. Choose a new id.')
      // YAML cannot preserve own properties whose values are undefined.
      return object(JSON.parse(JSON.stringify({ ...current, providers })))!
    })
    signal.throwIfAborted()
    this.options.apply()
  }
  private provider(input: JsonObject): string {
    if (typeof input.provider !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(input.provider)) throw new ManagementFailure('invalid-provider', 'Choose a provider id using letters, numbers, dots, underscores or hyphens.')
    return input.provider
  }
  /** Execute one validated operation. Billable checks and credentials remain owner-UI-only. */
  run(input: unknown, caller: 'user' | 'agent', signal?: AbortSignal): Promise<unknown> {
    if (this.lifetime.signal.aborted) return Promise.reject(new ManagementFailure('stopped', 'The gateway plugin stopped.'))
    // Match the owner endpoint's JSON wire shape; optional undefined fields are not valid Tool values.
    return this.execute(input, caller, AbortSignal.any([this.lifetime.signal, ...signal ? [signal] : []])).then(result => JSON.parse(JSON.stringify(result)))
  }
  private async execute(value: unknown, caller: 'user' | 'agent', signal: AbortSignal): Promise<unknown> {
    const input = object(value)
    if (!input || typeof input.action !== 'string') throw new ManagementFailure('invalid-request', 'Choose a gateway operation.')
    signal.throwIfAborted()
    if (input.action === 'describe') return this.describe()
    const provider = this.provider(input)
    if (input.action === 'save') {
      const patch = object(input.config)
      if (!patch) throw new ManagementFailure('invalid-config', 'Provide the gateway settings.')
      await this.write(input.revision, current => {
        if (input.create === true && current[provider]) throw new ManagementFailure('route-conflict', 'This WS route already exists. Choose a new id.')
        const { headersConfigured: _configured, ...fields } = patch
        const headers = patch.headers === undefined ? current[provider]?.headers ?? {} : patch.headers
        const parsed = Config({ providers: { [provider]: { ...fields, headers } as GatewayInput } }).providers[provider]!
        return { ...current, [provider]: parsed }
      }, signal)
    } else if (input.action === 'import' || input.action === 'merge-models') {
      const merging = input.action === 'merge-models'
      if (merging && caller !== 'user') throw new ManagementFailure('user-only', 'Merge selected model candidates in Settings.')
      await this.write(input.revision, current => {
        const source = this.sources().find(source => source.view.provider === input.source)
        if (source?.view.fingerprint !== input.sourceFingerprint) throw new ManagementFailure('source-changed', 'The source changed. Review its configuration again.')
        if (!source?.config) throw new ManagementFailure('incompatible-source', 'This provider cannot be imported with its current configuration.')
        const adopted = Config({ providers: { [provider]: source.config } }).providers[provider]!
        const target = Object.hasOwn(current, provider) ? current[provider] : undefined
        if (!merging) {
          if (target) throw new ManagementFailure('route-conflict', 'This WS route already exists. Choose a new id.')
          return { ...current, [provider]: adopted }
        }
        if (!target) throw new ManagementFailure('unknown-provider', 'This gateway no longer exists. Reload settings before merging.')
        if (!sameEndpoint(adopted.baseURL, target.baseURL)) throw new ManagementFailure('endpoint-mismatch', 'Choose a target that uses the same Responses endpoint as the source.')
        const ids = input.models
        if (!Array.isArray(ids) || ids.length === 0 || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) {
          throw new ManagementFailure('invalid-model-selection', 'Select one or more distinct models from the preview.')
        }
        const additions = adopted.models.filter(model => ids.includes(model.id))
        if (additions.length !== ids.length) throw new ManagementFailure('invalid-model-selection', 'Select models that still appear in the source preview.')
        if (additions.some(model => target.models.some(existing => existing.id === model.id))) throw new ManagementFailure('model-conflict', 'A selected model already exists on this route. Review the preview again.')
        if (target.reasoning !== undefined && additions.some(model => target.reasoning === 'off' ? model.reasoningEfforts.length > 0 : !model.reasoningEfforts.includes(target.reasoning!))) {
          throw new ManagementFailure('model-reasoning-conflict', "A selected model does not support the target route's default thinking level.")
        }
        return { ...current, [provider]: { ...target, models: [...target.models, ...additions] } }
      }, signal)
    } else if (input.action === 'delete') {
      await this.write(input.revision, current => { if (!current[provider]) throw new ManagementFailure('unknown-provider', 'This gateway no longer exists.'); delete current[provider]; return current }, signal)
    } else if (input.action === 'reset') await this.options.adapter.reset(provider)
    else if (input.action === 'refresh') {
      const route = this.options.current()[provider]
      if (!route) throw new ManagementFailure('unknown-provider', 'This gateway no longer exists. Reload settings.')
      const expected = input.revision
      if (expected !== undefined && expected !== this.revision()) throw new ManagementFailure('conflict', 'Gateway settings changed. Reload before refreshing again.')
      if (!route.discover) return { models: await this.options.adapter.listModels(provider), state: await this.describe(), discovery: 'disabled' }
      const models = await this.options.adapter.refreshModels(provider)
      signal.throwIfAborted()
      if (fingerprint(this.options.current()[provider]) !== fingerprint(route)) throw new ManagementFailure('conflict', 'Gateway settings changed during discovery. Reload before refreshing again.')
      const failed = this.options.adapter.diagnostics().routes.find(row => row.provider === provider)?.discoveryError !== undefined
      return { models, state: await this.describe(), discovery: failed ? 'failed' : 'refreshed' }
    }
    else if (input.action === 'credential') {
      if (caller !== 'user') throw new ManagementFailure('user-only', 'Credentials must be entered by the owner in Settings.')
      const route = this.options.current()[provider]
      if (!route || typeof input.key !== 'string' || input.key.length === 0 || input.key.length > 16_384) throw new ManagementFailure('invalid-credential', 'Enter a nonempty API key for this gateway.')
      await this.ctx.credentials.set(credentialRef(route.apiKeyEnv), input.key)
      await this.options.adapter.reset(provider)
    } else if (input.action === 'verify') {
      if (caller !== 'user' || input.allowBillable !== true) throw new ManagementFailure('user-only', 'Confirm the potentially billable verification in Settings.')
      return this.verify(provider, input.model, signal)
    } else throw new ManagementFailure('unknown-action', 'This gateway operation is not available.')
    return this.describe()
  }
  private async verify(provider: string, model: unknown, signal: AbortSignal) {
    if (typeof model !== 'string' || !this.options.current()[provider]?.models.some(m => m.id === model)) throw new ManagementFailure('unknown-model', 'Choose an explicitly configured model for verification.')
    const sessionId = `gateway-check-${randomUUID()}` as NonNullable<GenerateOptions['sessionId']>
    const token = `check-${randomUUID()}`
    let recalled = false
    const messages: RequestMessage[] = [{ role: 'user', content: [{ type: 'text', text: `Remember this token exactly: ${token}. Reply with OK only.` }] }]
    try {
    for (let round = 0; round < 2; round++) {
      const chunks: StreamChunk[] = []
      for await (const chunk of this.options.adapter.stream({ provider, model, sessionId, messages, maxTokens: 128, signal })) chunks.push(chunk)
      const finish = chunks.findLast(c => c.type === 'finish')
      if (finish?.type !== 'finish' || finish.reason.kind !== 'stop') throw new ManagementFailure('verification-failed', 'Verification did not complete. Review gateway diagnostics before retrying.')
      if (round === 0) {
        const content = chunks.flatMap(c => c.type === 'block-end' ? [c.block] : [])
        messages.push({ id: randomUUID() as NonNullable<Extract<RequestMessage, { role: 'assistant' }>['id']>, role: 'assistant', source: { kind: 'model', provider, model, replayState: finish.replayState }, content })
        messages.push({ role: 'user', content: [{ type: 'text', text: 'Return the exact token I asked you to remember, and nothing else.' }] })
      } else recalled = chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('').trim() === token
    }
    } finally { await this.options.adapter.releaseSession(provider, model, sessionId) }
    const requests = this.options.adapter.diagnostics().requests.filter(r => r.sessionId === sessionId)
    const delta = recalled && requests[1]?.attempts.some(a => a.transport === 'websocket' && a.delta) && !requests[1]?.attempts.some(a => a.resetReason === 'cache-miss') || false
    const websocket = requests.every(r => r.attempts.some(a => a.transport === 'websocket') && !r.attempts.some(a => a.transport === 'sse'))
    return { websocket, delta, requests, state: await this.describe() }
  }
}

declare module '@deepseek-ai/cordis' { interface Context { websocketGateway: GatewayManagement } }
