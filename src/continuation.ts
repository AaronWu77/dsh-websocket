/** Conservative, connection-local history fingerprints over the final Responses JSON. */
import { createHash } from 'node:crypto'

export type JsonObject = Record<string, unknown>
export function object(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : undefined
}
/** Stable JSON comparison; array order remains significant. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const item = object(value)
  if (item) return `{${Object.keys(item).filter(k => item[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical(item[k])}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}
export function fingerprint(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex') }

/** Normalize only replay differences that carry no message content. */
function replayItem(value: unknown): unknown {
  const item = object(value)
  if (!item) return value
  if (item.type === 'function_call' && (item.status === undefined || item.status === 'completed')) {
    const { status: _status, ...rest } = item
    if (typeof rest.arguments === 'string') {
      try { return { ...rest, arguments: canonical(JSON.parse(rest.arguments)) } }
      catch (_error) { return value /* Unparseable arguments cannot match a repaired tool replay. */ }
    }
    return rest
  }
  if (item.type === 'message' && item.role === 'assistant' && Array.isArray(item.content)) {
    let replay: unknown[] | undefined
    for (const [index, block] of item.content.entries()) {
      const part = object(block)
      if (part?.type !== 'output_text' || typeof part.text !== 'string' || !Array.isArray(part.annotations)
        || !Array.isArray(part.logprobs) || part.logprobs.length !== 0) continue
      // Responses permits the absence of token probabilities; pi-ai does not replay an empty list.
      const { logprobs: _empty, ...text } = part
      replay ??= [...item.content]
      replay[index] = text
    }
    if (replay !== undefined) return { ...item, content: replay }
  }
  return item
}

const itemTypes = ['message', 'function_call', 'function_call_output', 'reasoning', 'custom_tool_call',
  'custom_tool_call_output', 'item_reference', 'configuration_update'] as const
const itemFields = ['id', 'role', 'status', 'phase', 'content', 'name', 'call_id', 'arguments', 'output',
  'summary', 'encrypted_content'] as const
const contentFields = ['text', 'annotations', 'logprobs', 'refusal', 'image_url', 'file_id'] as const
const fields = [...itemFields, ...contentFields.map(field => `content[].${field}` as const)]
type ItemType = (typeof itemTypes)[number] | 'unknown'
type ComparedType = ItemType | 'missing'
type HistoryEntry = readonly [hash: string, type: ItemType, fieldMask: number]
interface Head { id: string; parameters: string; inputLength: number; history: HistoryEntry[] }

/** Lengths and first mismatch in the normalized history; no payload values or fingerprints are exposed. */
export interface ContinuationComparison {
  readonly kind: 'item-mismatch' | 'shorter-history' | 'no-new-input'
  readonly inputLength: number
  readonly previousInputLength: number
  readonly previousOutputLength: number
  readonly firstDifference?: {
    /** Zero-based position in the combined prior input and output. */
    readonly index: number
    readonly section: 'prior-input' | 'prior-output'
    readonly previousType: ItemType
    readonly currentType: ComparedType
    /** Presence changes for allowlisted fields; content fields are present if any block has them. */
    readonly fields: readonly {
      readonly name: (typeof fields)[number]
      readonly previousPresent: boolean
      readonly currentPresent: boolean
    }[]
  }
}

/** Stable reasons included in WebSocket attempt diagnostics. */
export type ResetReason = 'first-request' | 'disabled' | 'context-changed' | 'parameters-changed' | 'cache-limit' | 'cache-miss' | 'reconnected'

/** Full or incremental wire body, with optional value-free history comparison. */
interface ContinuationPlan {
  body: JsonObject
  delta: boolean
  reason?: ResetReason
  comparison?: ContinuationComparison
}

function itemType(item: JsonObject | undefined): ItemType {
  if (item?.type === undefined && (item?.role === 'user' || item?.role === 'system'
    || item?.role === 'developer' || item?.role === 'assistant')) return 'message'
  return itemTypes.find(type => type === item?.type) ?? 'unknown'
}

function fieldMask(item: JsonObject | undefined): number {
  if (item === undefined) return 0
  let mask = 0
  for (const [index, field] of itemFields.entries()) {
    if (Object.hasOwn(item, field) && item[field] !== undefined) mask |= 1 << index
  }
  if (Array.isArray(item.content)) {
    for (const value of item.content) {
      const block = object(value)
      if (block === undefined) continue
      for (const [index, field] of contentFields.entries()) {
        if (Object.hasOwn(block, field) && block[field] !== undefined) mask |= 1 << (itemFields.length + index)
      }
    }
  }
  return mask
}

function historyEntry(value: unknown): HistoryEntry {
  const normalized = replayItem(value)
  const item = object(normalized)
  return [fingerprint(normalized), itemType(item), fieldMask(item)]
}

function firstDifference(
  index: number, head: Head, previous: HistoryEntry, currentType: ComparedType, currentFields: number,
): NonNullable<ContinuationComparison['firstDifference']> {
  const [, previousType, previousFields] = previous
  return {
    index, section: index < head.inputLength ? 'prior-input' : 'prior-output', previousType, currentType,
    fields: fields.flatMap((name, index) => {
      const bit = 1 << index
      const previousPresent = (previousFields & bit) !== 0
      const currentPresent = (currentFields & bit) !== 0
      return previousPresent === currentPresent ? [] : [{ name, previousPresent, currentPresent }]
    }),
  }
}

/** Never stores prompt text. A head is valid only on its owning live connection. */
export class Continuation {
  private head?: Head
  constructor(private readonly maxBytes: number) {}
  reset(): void { this.head = undefined }
  get retainedBytes(): number { return this.head === undefined ? 0 : Buffer.byteLength(JSON.stringify(this.head)) }
  /**
   * Compare the complete known prefix before sending only new input; never rewrite wire items.
   * @param payload - complete serialized Responses request.
   * @param enabled - whether this request may use the connection's continuation head.
   * @returns the wire body and a value-free diagnostic when history prevents continuation.
   */
  plan(payload: JsonObject, enabled: boolean): ContinuationPlan {
    const { stream: _stream, background: _background, input, previous_response_id: _previous, ...parameters } = payload
    const full = { ...parameters, input }
    if (!enabled || !Array.isArray(input)) return { body: full, delta: false, reason: 'disabled' }
    const head = this.head
    if (!head) return { body: full, delta: false, reason: 'first-request' }
    if (head.parameters !== fingerprint(parameters)) return { body: full, delta: false, reason: 'parameters-changed' }
    const lengths = { inputLength: input.length, previousInputLength: head.inputLength, previousOutputLength: head.history.length - head.inputLength }
    const changed = (comparison: ContinuationComparison): ContinuationPlan => ({ body: full, delta: false, reason: 'context-changed', comparison })
    for (const [index, previous] of head.history.entries()) {
      if (index >= input.length) {
        return changed({ ...lengths, kind: 'shorter-history', firstDifference: firstDifference(index, head, previous, 'missing', 0) })
      }
      const current = replayItem(input[index])
      if (fingerprint(current) !== previous[0]) {
        const item = object(current)
        return changed({ ...lengths, kind: 'item-mismatch', firstDifference: firstDifference(index, head, previous, itemType(item), fieldMask(item)) })
      }
    }
    if (input.length === head.history.length) return changed({ ...lengths, kind: 'no-new-input' })
    return { body: { ...parameters, previous_response_id: head.id, input: input.slice(head.history.length) }, delta: true }
  }

  /**
   * Replace the head with a bounded fingerprint of a completed response and its request.
   * @param payload - full request, even if only its suffix was sent over the connection.
   * @param response - the terminal Responses object received from the connection.
   * @returns whether the new head was retained; a rejection clears the previous head.
   */
  commit(payload: JsonObject, response: unknown): boolean {
    this.reset()
    const result = object(response)
    if (!result || result.status !== 'completed' || typeof result.id !== 'string' || !Array.isArray(result.output) || !Array.isArray(payload.input)) return false
    // Nonempty annotations or unfamiliar items are not discarded to manufacture a prefix match.
    const allowed = new Set(['message', 'function_call', 'reasoning'])
    if (result.output.some(value => { const item = object(value); return !item || !allowed.has(String(item.type)) })) return false
    const { stream: _stream, background: _background, input, previous_response_id: _previous, ...parameters } = payload
    const head = { id: result.id, parameters: fingerprint(parameters), inputLength: input.length, history: [...input, ...result.output].map(historyEntry) }
    if (Buffer.byteLength(JSON.stringify(head)) > this.maxBytes) return false
    this.head = head
    return true
  }
}
