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

/** One separately named API-key route. Timing and size limits are configurable. */
export interface GatewayConfig {
  displayName?: string
  baseURL: string
  apiKeyEnv: string
  transport: 'auto' | 'sse'
  headers: Record<string, string>
  models: GatewayModelConfig[]
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
/** User-authored gateway fields before schema defaults are applied. */
export type GatewayInput = Pick<GatewayConfig, 'baseURL' | 'apiKeyEnv'> & Partial<Omit<GatewayConfig, 'baseURL' | 'apiKeyEnv' | 'models'>> & { models: GatewayModelInput[] }
/** Optional route dictionary accepted at the configuration parser. */
export interface ConfigInput { providers?: Record<string, GatewayInput> }

const positive = () => z.number().step(1).min(1).max(2_147_483_647)
const modelSchema: z<GatewayModelInput, GatewayModelConfig> = z.object({
  id: z.string().required(),
  name: z.string(),
  contextWindow: positive().required(),
  maxTokens: positive().required(),
  input: z.array(z.union(['text', 'image'])).default(['text']),
  reasoningEfforts: z.array(z.union(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])).default([]),
})
const gatewaySchema: z<GatewayInput, GatewayConfig> = z.object({
  displayName: z.string(),
  baseURL: z.string().required(),
  apiKeyEnv: z.string().role('credential-ref').required(),
  transport: z.union(['auto', 'sse']).default('auto'),
  headers: z.dict(z.string()).default({}),
  models: z.array(modelSchema).required(),
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
 * Resolve one complete configuration before registering any route.
 * @param config - Loader-validated user configuration.
 * @returns detached route generations, or a descriptive configuration failure.
 */
export function resolveRoutes(config: Config): ReadonlyMap<string, GatewayRoute> {
  if (Object.keys(config).some(key => key !== 'providers')) throw new LlmError('GPT gateway configuration accepts only providers.', 'INVALID_CONFIG')
  const routes = new Map<string, GatewayRoute>()
  const allowedGatewayKeys = ['displayName', 'baseURL', 'apiKeyEnv', 'transport', 'headers', 'models', 'websocketConnectTimeoutMs', 'closeTimeoutMs', 'streamIdleTimeoutMs', 'maxFrameBytes', 'maxBufferedEvents', 'maxRequestImageBytes', 'maxRequestImages', 'imageOffloadCountQuantum', 'requestImagePixelBudget', 'requestImageMaxBytes', 'supportsMaxOutputTokens', 'retryPolicy']
  const allowedModelKeys = ['id', 'name', 'contextWindow', 'maxTokens', 'input', 'reasoningEfforts']
  for (const [id, raw] of Object.entries(config.providers)) {
    if (Object.keys(raw).some(key => !allowedGatewayKeys.includes(key)) || raw.models.some(model => Object.keys(model).some(key => !allowedModelKeys.includes(key)))) {
      throw new LlmError(`GPT gateway "${id}" contains an unsupported configuration field.`, 'INVALID_CONFIG')
    }
    if (id.trim().length === 0) throw new LlmError('A GPT gateway route needs a non-empty id.', 'INVALID_CONFIG')
    const cfg = structuredClone(raw)
    const url = new URL(cfg.baseURL)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new LlmError(`GPT gateway "${id}" needs an HTTP(S) base URL without credentials, query or fragment.`, 'INVALID_CONFIG')
    }
    if (cfg.models.length === 0) throw new LlmError(`GPT gateway "${id}" must explicitly list its GPT models.`, 'INVALID_CONFIG')
    if (cfg.imageOffloadCountQuantum > cfg.maxRequestImages) throw new LlmError(`GPT gateway "${id}" image offload count exceeds its retained-image limit.`, 'INVALID_CONFIG')
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
      const thinkingLevelMap: Partial<Record<ModelThinkingLevel, string | null>> = {
        off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: null,
      }
      for (const effort of model.reasoningEfforts) thinkingLevelMap[effort] = effort
      return {
        id: model.id, name: model.name ?? model.id, provider: id, api: 'openai-responses', baseUrl: cfg.baseURL,
        reasoning: model.reasoningEfforts.length > 0, input: [...model.input],
        contextWindow: model.contextWindow, maxTokens: model.maxTokens, thinkingLevelMap,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: { supportsMaxOutputTokens: cfg.supportsMaxOutputTokens },
      }
    })
    const profile: ResolvedPiAiProviderProfile = {
      provider: id, displayName: cfg.displayName ?? id, api: 'openai-responses', baseURL: cfg.baseURL,
      apiKeyEnv: credentialRef(cfg.apiKeyEnv), headers: { ...cfg.headers },
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
