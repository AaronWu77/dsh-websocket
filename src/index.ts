/** Optional standalone Responses routes with live settings; existing provider registrations stay untouched. */
import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { assertUsableApiKey, LlmError } from '@deepseek-ai/dsh-llm'
import type { AdapterRegistrationHandle } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-credentials'
import { GatewayAdapter } from './adapter.ts'
import { Config as PlainConfig, gatewaySchema, resolveRoutes } from './config.ts'
import type { ConfigInput, GatewayConfig } from './config.ts'
import { GatewayManagement, ManagementFailure } from './management.ts'
import { object, fingerprint } from './continuation.ts'

/** The dictionary updates in place; each admitted request retains an immutable route generation. */
export const Config = z.object({ providers: z.dict(gatewaySchema).default({}).volatile() })
export const name = 'dsh-websocket'
export const inject = ['llm', 'credentials']

/** Mount routes, owner settings, and the same non-billable management operations for agents. */
export function apply(ctx: Context, config: { providers: Volatile<Record<string, GatewayConfig>> }): void {
  // structuredClone detaches the readonly volatile snapshot before schema resolution and editing.
  const current = () => structuredClone(config.providers.get()) as Record<string, GatewayConfig>
  let routes = resolveRoutes({ providers: current() })
  let registration: AdapterRegistrationHandle | undefined
  let facts = ''
  const adapter = new GatewayAdapter(routes, {
    resolveApiKey: async (provider, profile) => {
      if (profile.apiKeyEnv === undefined) throw new LlmError(`GPT gateway "${provider}" has no credential reference.`, 'MISSING_CREDENTIAL')
      const credential = await ctx.credentials.resolve(profile.apiKeyEnv)
      if (credential === undefined) throw new LlmError(`Set the configured credential reference for GPT gateway "${provider}" before requesting its models.`, 'MISSING_CREDENTIAL')
      return assertUsableApiKey(credential.value, name, profile.apiKeyEnv)
    },
    resolveAttachments: () => ctx.get('attachments'),
    prepareHeaders: (request, headers) => ctx.waterfall('llm-pi-ai/request-headers', request, headers, () => headers),
    onCleanupError: provider => ctx.logger.error(`GPT gateway ${provider}: connection cleanup failed. Review diagnostics before sending more requests.`),
    onReplayDegrade: ({ provider, model }) => ctx.logger.warn(`GPT gateway ${provider}/${model}: unusable native replay metadata; sending provider-neutral history.`),
    onModelsUpdated: provider => { ctx.emit('llm/models-updated', provider) },
    onDiscoveryError: provider => ctx.logger.warn(`GPT gateway ${provider}: model discovery failed; keeping explicitly configured models.`),
    onCircuitOpen: (provider, failures, cooldownMs) => ctx.logger.warn(`GPT gateway ${provider}: ${failures} WS connection failures; using SSE for ${cooldownMs} ms before a new request probes WS.`),
    report: (provider, event) => {
      const text = `GPT gateway ${provider}: ${event.transport} ${event.phase}${event.code === undefined ? '' : ` (${event.code})`}`
      if (event.phase === 'fallback') ctx.logger.warn(text)
      else ctx.logger.info(text)
    },
  })
  ctx.effect(() => () => adapter.dispose(), 'dsh-websocket: cancel requests and close all session connections')
  const reconcile = (): void => {
    const values = current()
    const nextFacts = fingerprint(values)
    if (facts === nextFacts) return
    const next = resolveRoutes({ providers: values })
    const old = routes
    adapter.updateRoutes(next)
    try {
      if (registration) registration.replace([...next.keys()])
      else if (next.size) registration = ctx.llm.registerAdapter([...next.keys()], adapter)
    } catch (error) { adapter.updateRoutes(old); throw error }
    routes = next; facts = nextFacts
  }
  reconcile()
  ctx.on('internal/config', (fiber, next) => {
    const raw: unknown = next()
    if (fiber === ctx.fiber) {
      const candidate = PlainConfig(structuredClone(raw) as ConfigInput)
      resolveRoutes(candidate)
      const owned = new Set(Object.keys(config.providers.get()))
      if (ctx.llm.listProviders().some(p => !owned.has(p.id) && Object.hasOwn(candidate.providers, p.id))) throw new LlmError('This gateway provider id is already registered by another adapter.', 'DUPLICATE_ADAPTER')
    }
    return raw
  })
  ctx.on('loader/volatile-update', reconcile)
  ctx.inject(['settings'], child => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  const management = new GatewayManagement(ctx, { current, adapter, apply: reconcile })
  ctx.inject(['connection'], child => {
    child.effect(() => child.connection.fetch.register({
      path: '/api/dsh-websocket', methods: ['POST'], requestBody: 'buffered',
      fetch: async request => {
        try {
          const input: unknown = await request.json()
          const result = await management.run(input, 'user', request.signal)
          return Response.json({ ok: true, value: result }, { headers: { 'cache-control': 'no-store' } })
        } catch (error: unknown) {
          const failure = error instanceof ManagementFailure ? error : new ManagementFailure('rejected', 'Gateway operation failed. Review the fields, reload settings, and try again.')
          return Response.json({ ok: false, error: { code: failure.code, message: failure.message } }, { status: failure.code === 'conflict' ? 409 : 400, headers: { 'cache-control': 'no-store' } })
        }
      },
    }), 'dsh-websocket: owner-only settings endpoint')
  })
  ctx.inject(['tools'], child => {
    child.effect(() => child.tools.register({
      name: 'websocket_gateway',
      description: 'Read and configure standalone GPT WebSocket gateways, import a compatible provider into a new route, refresh its model list, or reset idle connections. Does not run inference checks or change selected models. Use describe to obtain the revision before saving, importing or deleting.',
      parameters: { type: 'object', properties: {
        action: { type: 'string', enum: ['describe', 'save', 'import', 'delete', 'refresh', 'reset'] },
        provider: { type: 'string', description: 'Standalone WS route id; required except for describe.' },
        revision: { type: 'string', description: 'Revision returned by describe; required for save, import and delete.' },
        config: { type: 'object', description: 'Complete gateway fields for save; omitted headers retain stored values.', additionalProperties: true },
        source: { type: 'string', description: 'Existing provider to copy during import.' },
        sourceFingerprint: { type: 'string', description: 'Fingerprint of the reviewed source from describe.' },
      }, required: ['action'] },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: async (args, exec) => {
        if (!['describe', 'save', 'import', 'delete', 'refresh', 'reset'].includes(String(object(args)?.action))) throw new ManagementFailure('user-only', 'Use the owner Settings page for this operation.')
        return management.run(args, 'agent', exec.signal)
      },
      presentCall: () => ({ card: 'generic', title: 'WebSocket gateway settings', kind: 'other' }),
    }), 'dsh-websocket: management tool')
  })
}
