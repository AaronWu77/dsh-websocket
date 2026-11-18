import { Config as PiAiConfig } from '@deepseek-ai/dsh-llm-pi-ai'
import { builtinProviders, getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import { Config, resolveRoutes } from './config.ts'
import type { GatewayConfig, GatewayInput } from './config.ts'
import { fingerprint, object } from './continuation.ts'
import type { JsonObject } from './continuation.ts'

type CapacityField = 'contextWindow' | 'maxTokens'
type CapacitySource = 'explicit-model' | 'catalog' | 'route-default' | 'builtin-default'
export interface ModelImportPreview {
  id: string
  contextWindow: { value: number; source: CapacitySource }
  maxTokens: { value: number; source: CapacitySource }
}
export interface SourceCandidate {
  provider: string
  displayName: string
  eligible: boolean
  reason?: string
  model?: string
  field?: CapacityField
  fingerprint: string
  preview?: ModelImportPreview[]
  draft?: Omit<GatewayInput, 'headers'> & { headersConfigured: boolean }
}
export interface Source { view: SourceCandidate; config?: GatewayInput }
const efforts = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
function configured(value: unknown): boolean {
  if (value === undefined || value === null) return false
  if (Array.isArray(value)) return value.length > 0
  const item = object(value)
  return item ? Object.values(item).some(configured) : true
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647
}

function capacity(model: JsonObject, field: CapacityField, catalog: number | undefined, effective: unknown, declared: unknown) {
  if (model[field] !== undefined && model[field] !== null) {
    const value = model[field]
    return positive(value) ? { value, source: 'explicit-model' as const } : undefined
  }
  if (catalog !== undefined) return positive(catalog) ? { value: catalog, source: 'catalog' as const } : undefined
  return positive(effective) ? { value: effective, source: declared == null ? 'builtin-default' as const : 'route-default' as const } : undefined
}

/**
 * Preview a local provider's configured models using pi-ai's capacity precedence. No network I/O.
 * @param provider - Original configured route ID.
 * @param value - Effective Settings values for the source route.
 * @param declarations - Pre-schema route values, to distinguish explicit defaults from built-in defaults.
 * @param useCatalog - Whether the original pi-ai adapter recognizes this provider in its installed catalog.
 * @returns Sanitized preview and, for a compatible source, Host-only values to copy.
 */
export function sourceCandidate(provider: string, value: unknown, declarations: unknown = value, useCatalog = true): Source {
  const raw = object(value) ?? {}
  const declared = object(declarations) ?? {}
  const view: SourceCandidate = { provider, displayName: typeof raw.displayName === 'string' ? raw.displayName : provider, eligible: false, fingerprint: fingerprint(raw) }
  const reject = (reason: string, model?: string, field?: CapacityField): Source => ({ view: { ...view, reason, ...model === undefined ? {} : { model }, ...field === undefined ? {} : { field } } })
  if (raw.api !== 'openai-responses') return reject('protocol')
  if (typeof raw.baseURL !== 'string' || typeof raw.apiKeyEnv !== 'string') return reject('endpoint-or-credential')
  if (raw.proxy || raw.proxyUrl || raw.enableProxy || raw.httpProxy || raw.fetch || raw.transport === 'websocket') return reject('unsupported-transport')
  if (configured(raw.compat) || configured(raw.modelOverrides) || configured(raw.thinkingBudgets)) return reject('custom-capabilities')
  if (!Array.isArray(raw.models)) return reject('explicit-models-required')
  const defaults = PiAiConfig({ providers: { preview: {} } }).providers.get().preview
  const builtin = useCatalog ? builtinProviders().find(item => item.id === provider) : undefined
  const catalog = builtin === undefined ? [] : getBuiltinModels(builtin.id as Parameters<typeof getBuiltinModels>[0])
  const models: NonNullable<GatewayInput['models']> = []
  const preview: ModelImportPreview[] = []
  const ids = new Set<string>()
  for (const entry of raw.models) {
    const model = object(entry), id = model?.id
    if (!model || typeof id !== 'string' || !/^(?:openai\/)?gpt-/i.test(id) || /(?:image|audio|realtime|embedding|tts|transcri)/i.test(id)) continue
    if (ids.has(id)) return reject('duplicate-model', id)
    ids.add(id)
    const base = catalog.find(item => item.id === id)
    const contextWindow = capacity(model, 'contextWindow', base?.contextWindow, raw.defaultContextWindow ?? defaults?.defaultContextWindow, declared.defaultContextWindow)
    if (!contextWindow) return reject('model-metadata-required', id, 'contextWindow')
    const maxTokens = capacity(model, 'maxTokens', base?.maxTokens, raw.defaultMaxTokens ?? defaults?.defaultMaxTokens, declared.defaultMaxTokens)
    if (!maxTokens) return reject('model-metadata-required', id, 'maxTokens')
    const map = object(model.reasoningEfforts) ?? (model.reasoningEfforts !== false && base?.reasoning ? base.thinkingLevelMap : undefined) ?? {}
    if (Object.entries(map).some(([key, wire]) => wire != null && (key === 'off' || !efforts.has(key) || wire !== key))) return reject('custom-reasoning', id)
    const keys = Object.keys(model)
    if (keys.some(k => !['id', 'name', 'contextWindow', 'maxTokens', 'reasoningEfforts', 'input', 'compat'].includes(k)) || configured(model.compat)) return reject('custom-capabilities', id)
    const input = Array.isArray(model.input) && model.input.length > 0 ? model.input : base?.input ?? raw.defaultInput ?? ['text']
    if (!Array.isArray(input) || input.some(v => v !== 'text' && v !== 'image')) return reject('custom-capabilities', id)
    models.push({ id, name: typeof model.name === 'string' ? model.name : base?.name ?? id, contextWindow: contextWindow.value, maxTokens: maxTokens.value, input, reasoningEfforts: Object.entries(map).filter(([key, wire]) => efforts.has(key) && wire === key).map(([key]) => key) as GatewayConfig['models'][number]['reasoningEfforts'] })
    preview.push({ id, contextWindow, maxTokens })
  }
  if (!models.length) return reject('no-gpt-models')
  const reviewedFingerprint = fingerprint([raw, preview, models])
  const config: GatewayInput = { displayName: `${view.displayName} (WebSocket)`, baseURL: raw.baseURL, apiKeyEnv: raw.apiKeyEnv, models, sourceProvider: provider, sourceFingerprint: reviewedFingerprint }
  if (raw.headers !== undefined) {
    const headers = object(raw.headers)
    if (!headers || Object.values(headers).some(v => typeof v !== 'string')) return reject('custom-headers')
    config.headers = headers as Record<string, string>
  }
  try { resolveRoutes(Config({ providers: { candidate: config } })) }
  catch (_error) { return reject('invalid-configuration') }
  const { headers: _headers, ...draft } = config
  return { view: { ...view, eligible: true, fingerprint: reviewedFingerprint, preview, draft: { ...draft, headersConfigured: Boolean(config.headers && Object.keys(config.headers).length) } }, config }
}

/** @param left - source base URL. @param right - destination base URL. @returns Whether requests use the same Responses endpoint. */
export function sameEndpoint(left: string, right: string): boolean {
  const endpoint = (value: string) => { const url = new URL(value); return [url.origin, url.pathname.replace(/\/+$/u, '')] }
  const [leftOrigin, leftPath] = endpoint(left), [rightOrigin, rightPath] = endpoint(right)
  return leftOrigin === rightOrigin && leftPath === rightPath
}
