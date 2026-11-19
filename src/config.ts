/** Validated, explicit GPT gateway declarations; no existing provider is changed. */
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { LlmError, resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import type { Model, ModelThinkingLevel } from '@earendil-works/pi-ai'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'

/** Model metadata explicitly adopted by this plugin, not discovered by model-name guessing. */
export interface GatewayModelConfig {
  id: string
  name?: string
  contextWindow: number
  maxTokens: number
  input: ('text' | 'image')[]
  reasoningEfforts: ('minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max')[]
}

/** Metadata used for models the gateway lists but the configuration does not override. */
export interface GatewayDiscoveryConfig {
  contextWindow: number
  maxTokens: number
  input: ('text' | 'image')[]
  reasoningEfforts: ('minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max')[]
  exclude: string[]
  timeoutMs: number
  ttlMs: number
  maxResponseBytes: number
  maxModels: number
}

/** One separately named API-key route. Timing and size limits are configurable. */
export interface GatewayConfig {
  displayName?: string
  baseURL: string
  apiKeyEnv: string
  transport: 'auto' | 'sse'
  requestFormat: 'standard' | 'codex' | 'codex-instructions'
  /** Codex-compatible client metadata framing for gateways that need a stable upstream session. */
  clientMetadata: 'off' | 'codex'
  reuseConnection: boolean
  continuation: boolean
  connectionIdleMs: number
  connectionMaxAgeMs: number
  maxConnections: number
  maxContinuationBytes: number
  diagnosticsLimit: number
  sourceProvider?: string
  sourceFingerprint?: string
  headers: Record<string, string>
  /** Default effort for requests without a selection; every adopted model declaration must support it. */
  reasoning?: ModelThinkingLevel
  models: GatewayModelConfig[]
  discover: boolean
  discovery: GatewayDiscoveryConfig
  fallbackAfterFailures: number
  fallbackCooldownMs: number
  websocketConnectTimeoutMs: number
  closeTimeoutMs: number
  streamIdleTimeoutMs: number
  maxFrameBytes: number
  maxBufferedEvents: number
  maxRequestImageBytes: number
  maxRequestImages: number
  imageOffloadCountQuantum: number
  requestImagePixelBudget: number
  requestImageMaxBytes: number
  supportsMaxOutputTokens: boolean
  retryPolicy?: RetryPolicyConfig
}

/** Plugin configuration. An empty dictionary leaves every model route untouched. */
export interface Config { providers: Record<string, GatewayConfig> }
/** User-authored model fields before schema defaults are applied. */
export type GatewayModelInput = Pick<GatewayModelConfig, 'id' | 'contextWindow' | 'maxTokens'> & Partial<Omit<GatewayModelConfig, 'id' | 'contextWindow' | 'maxTokens'>>
/** Optional discovery metadata overrides; omitted fields use schema defaults. */
export type GatewayDiscoveryInput = Partial<GatewayDiscoveryConfig>
/** User-authored gateway fields before schema defaults are applied. */
export type GatewayInput = Pick<GatewayConfig, 'baseURL' | 'apiKeyEnv'> & Partial<Omit<GatewayConfig, 'baseURL' | 'apiKeyEnv' | 'models' | 'discovery'>> & {
  models?: GatewayModelInput[]
  discovery?: GatewayDiscoveryInput
}
/** Optional route dictionary accepted at the configuration parser. */
export interface ConfigInput { providers?: Record<string, GatewayInput> }

const positive = () => z.number().step(1).min(1).max(2_147_483_647)
const effort = z.union(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
const modelSchema: z<GatewayModelInput, GatewayModelConfig> = z.object({
  id: z.string().required(),
  name: z.string(),
  contextWindow: positive().required(),
  maxTokens: positive().required(),
  input: z.array(z.union(['text', 'image'])).default(['text']),
  reasoningEfforts: z.array(effort).default([]),
})
const discoverySchema: z<GatewayDiscoveryInput, GatewayDiscoveryConfig> = z.object({
  contextWindow: positive().default(500_000),
  maxTokens: positive().default(128_000),
  input: z.array(z.union(['text', 'image'])).default(['text', 'image']),
  reasoningEfforts: z.array(effort).default(['high', 'xhigh', 'max']),
  exclude: z.array(z.string()).default([]),
  timeoutMs: positive().default(10_000),
  ttlMs: positive().default(300_000),
  maxResponseBytes: positive().default(4_194_304),
  maxModels: positive().max(10_000).default(1000),
})
export const gatewaySchema: z<GatewayInput, GatewayConfig> = z.object({
  displayName: z.string(),
  baseURL: z.string().required(),
  apiKeyEnv: z.string().role('credential-ref').required(),
  transport: z.union(['auto', 'sse']).default('auto'),
  requestFormat: z.union(['standard', 'codex', 'codex-instructions']).default('standard'),
  clientMetadata: z.union(['off', 'codex']).default('off'),
  reuseConnection: z.boolean().default(true),
  continuation: z.boolean().default(true),
  connectionIdleMs: positive().default(300_000),
  connectionMaxAgeMs: positive().max(3_540_000).default(3_000_000),
  maxConnections: positive().max(128).default(8),
  maxContinuationBytes: positive().max(16_777_216).default(1_048_576),
  diagnosticsLimit: positive().max(1000).default(100),
  sourceProvider: z.string(),
  sourceFingerprint: z.string(),
  headers: z.dict(z.string()).default({}),
  reasoning: z.union([z.const('off'), effort]),
  models: z.array(modelSchema).default([]),
  discover: z.boolean().default(false),
  discovery: discoverySchema.default({}),
  fallbackAfterFailures: z.number().step(1).min(0).max(2_147_483_647).default(5),
  fallbackCooldownMs: positive().default(300_000),
  websocketConnectTimeoutMs: positive().default(10_000),
  closeTimeoutMs: positive().default(2_000),
  streamIdleTimeoutMs: positive().default(300_000),
  maxFrameBytes: positive().default(8 * 1024 * 1024),
  maxBufferedEvents: positive().default(128),
  maxRequestImageBytes: positive().default(20 * 1024 * 1024),
  maxRequestImages: positive().default(50),
  imageOffloadCountQuantum: positive().default(10),
  requestImagePixelBudget: positive().default(4_194_304),
  requestImageMaxBytes: positive().default(1_048_576),
  supportsMaxOutputTokens: z.boolean().default(true),
  retryPolicy: RetryPolicySchema,
})

/** Loader schema; provider additions are opt-in and reject invalid declarations at activation. */
export const Config: z<ConfigInput, Config> = z.object({ providers: z.dict(gatewaySchema).default({}) })

/** One immutable route generation, shared by metadata and eventual request dispatch. */
export interface GatewayRoute {
  id: string
  config: GatewayConfig
  profile: ResolvedPiAiProviderProfile
  models: readonly Model<'openai-responses'>[]
}

/**
 * Build one pi-ai model entry from explicit or discovered gateway metadata.
 * @param routeId - provider route id.
 * @param cfg - resolved gateway configuration.
 * @param id - model id.
 * @param name - display name.
 * @param contextWindow - context window in tokens.
 * @param maxTokens - maximum output tokens.
 * @param input - accepted input modalities.
 * @param efforts - supported reasoning efforts.
 * @returns model metadata for the Responses protocol.
 */
export function createGatewayModel(
  routeId: string,
  cfg: GatewayConfig,
  id: string,
  name: string,
  contextWindow: number,
  maxTokens: number,
  input: readonly ('text' | 'image')[],
  efforts: readonly ('minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max')[],
): Model<'openai-responses'> {
  const thinkingLevelMap: Partial<Record<ModelThinkingLevel, string | null>> = {
    off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: null,
  }
  for (const effort of efforts) thinkingLevelMap[effort] = effort
  return {
    id, name, provider: routeId, api: 'openai-responses', baseUrl: cfg.baseURL,
    reasoning: efforts.length > 0, input: [...input],
    contextWindow, maxTokens, thinkingLevelMap,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: { supportsMaxOutputTokens: cfg.supportsMaxOutputTokens },
  }
}

/**
 * Resolve one complete configuration before registering any route.
 * @param config - Loader-validated user configuration.
 * @returns detached route generations, or a descriptive configuration failure.
 */
export function resolveRoutes(config: Config): ReadonlyMap<string, GatewayRoute> {
  if (Object.keys(config).some(key => key !== 'providers')) throw new LlmError('GPT gateway configuration accepts only providers.', 'INVALID_CONFIG')
  const routes = new Map<string, GatewayRoute>()
  if (Object.keys(config.providers).length > 128) throw new LlmError('At most 128 standalone gateway routes may be configured.', 'INVALID_CONFIG')
  const allowedGatewayKeys = ['reuseConnection', 'continuation', 'connectionIdleMs', 'connectionMaxAgeMs', 'maxConnections', 'maxContinuationBytes', 'diagnosticsLimit', 'sourceProvider', 'sourceFingerprint', 'displayName', 'baseURL', 'apiKeyEnv', 'transport', 'requestFormat', 'clientMetadata', 'headers', 'reasoning', 'models', 'discover', 'discovery', 'fallbackAfterFailures', 'fallbackCooldownMs', 'websocketConnectTimeoutMs', 'closeTimeoutMs', 'streamIdleTimeoutMs', 'maxFrameBytes', 'maxBufferedEvents', 'maxRequestImageBytes', 'maxRequestImages', 'imageOffloadCountQuantum', 'requestImagePixelBudget', 'requestImageMaxBytes', 'supportsMaxOutputTokens', 'retryPolicy']
  const allowedModelKeys = ['id', 'name', 'contextWindow', 'maxTokens', 'input', 'reasoningEfforts']
  const allowedDiscoveryKeys = ['maxResponseBytes', 'maxModels', 'contextWindow', 'maxTokens', 'input', 'reasoningEfforts', 'exclude', 'timeoutMs', 'ttlMs']
  for (const [id, raw] of Object.entries(config.providers)) {
    if (Object.keys(raw).some(key => !allowedGatewayKeys.includes(key))
      || raw.models.some(model => Object.keys(model).some(key => !allowedModelKeys.includes(key)))
      || Object.keys(raw.discovery).some(key => !allowedDiscoveryKeys.includes(key))) {
      throw new LlmError(`GPT gateway "${id}" contains an unsupported configuration field.`, 'INVALID_CONFIG')
    }
    if (id.trim().length === 0) throw new LlmError('A GPT gateway route needs a non-empty id.', 'INVALID_CONFIG')
    const cfg = structuredClone(raw)
    if (cfg.retryPolicy?.mode === 'always' || cfg.retryPolicy?.mode === 'normal' && cfg.retryPolicy.retryableCodes?.some(code => ['OUTCOME_UNKNOWN', 'UPSTREAM_SERVER_ERROR', 'UPSTREAM_RATE_LIMIT', 'AUTH', 'QUOTA', 'ABORTED', 'INVALID_REQUEST'].includes(code))) {
      throw new LlmError(`GPT gateway "${id}" requires finite retries excluding unknown outcomes, post-submit upstream failures, authentication, quota, cancellation and invalid requests.`, 'INVALID_CONFIG')
    }
    const url = new URL(cfg.baseURL)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new LlmError(`GPT gateway "${id}" needs an HTTP(S) base URL without credentials, query or fragment.`, 'INVALID_CONFIG')
    }
    if (cfg.models.length === 0 && !cfg.discover) {
      throw new LlmError(`GPT gateway "${id}" must list its GPT models or enable discovery.`, 'INVALID_CONFIG')
    }
    if (cfg.imageOffloadCountQuantum > cfg.maxRequestImages) throw new LlmError(`GPT gateway "${id}" image offload count exceeds its retained-image limit.`, 'INVALID_CONFIG')
    if (cfg.discovery.input.length === 0 || new Set(cfg.discovery.input).size !== cfg.discovery.input.length
      || new Set(cfg.discovery.reasoningEfforts).size !== cfg.discovery.reasoningEfforts.length) {
      throw new LlmError(`GPT gateway "${id}" discovery has empty or duplicate capabilities.`, 'INVALID_CONFIG')
    }
    new Headers(cfg.headers)
    const seen = new Set<string>()
    const models: Model<'openai-responses'>[] = cfg.models.map(model => {
      if (!/^(?:openai\/)?gpt-/i.test(model.id) || seen.has(model.id)) {
        throw new LlmError(`GPT gateway "${id}" accepts unique, explicit GPT model ids only.`, 'INVALID_CONFIG')
      }
      if (model.input.length === 0 || new Set(model.input).size !== model.input.length || new Set(model.reasoningEfforts).size !== model.reasoningEfforts.length) {
        throw new LlmError(`GPT gateway "${id}" model "${model.id}" has empty or duplicate capabilities.`, 'INVALID_CONFIG')
      }
      seen.add(model.id)
      return createGatewayModel(id, cfg, model.id, model.name ?? model.id, model.contextWindow, model.maxTokens, model.input, model.reasoningEfforts)
    })
    const reasoning = cfg.reasoning
    if (reasoning !== undefined) {
      const supports = (efforts: GatewayModelConfig['reasoningEfforts']): boolean => reasoning === 'off' ? efforts.length === 0 : efforts.includes(reasoning)
      const unsupported = cfg.models.find(model => !supports(model.reasoningEfforts))
      if (unsupported !== undefined) throw new LlmError(`GPT gateway "${id}" default reasoning "${reasoning}" is not supported by model "${unsupported.id}".`, 'INVALID_CONFIG')
      if (cfg.discover && !supports(cfg.discovery.reasoningEfforts)) throw new LlmError(`GPT gateway "${id}" default reasoning "${reasoning}" is not supported by discovery models.`, 'INVALID_CONFIG')
    }
    const profile: ResolvedPiAiProviderProfile = {
      provider: id, displayName: cfg.displayName ?? id, api: 'openai-responses', baseURL: cfg.baseURL,
      apiKeyEnv: credentialRef(cfg.apiKeyEnv), headers: { ...cfg.headers },
      ...reasoning === undefined ? {} : { reasoning },
      streamIdleTimeoutMs: cfg.streamIdleTimeoutMs,
      maxRequestImageBytes: cfg.maxRequestImageBytes, maxRequestImages: cfg.maxRequestImages,
      imageOffloadCountQuantum: cfg.imageOffloadCountQuantum,
      requestImagePixelBudget: cfg.requestImagePixelBudget, requestImageMaxBytes: cfg.requestImageMaxBytes,
      retryPolicy: resolveRetryPolicy(cfg.retryPolicy, `gpt-ws-gateway.providers.${id}.retryPolicy`),
      modelErrors: new Map(), configuredMaxTokens: new Map(models.map(model => [model.id, model.maxTokens])),
    }
    routes.set(id, { id, config: cfg, profile, models })
  }
  return routes
}
