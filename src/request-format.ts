/** Project prepared Responses requests onto the selected public wire format. */
import { object } from './continuation.ts'
import type { JsonObject } from './continuation.ts'

export type CodexRequestFormat = 'codex' | 'codex-instructions'

/**
 * Project only the serializer’s initial developer message. Do not move later history or overwrite existing instructions.
 * @param payload - Complete canonical Responses payload from the provider serializer.
 * @param format - Keep a typed developer prefix, or move it to instructions repeated on every frame.
 * @returns A Codex-style payload without changing instruction text, replay items or authentication.
 */
export function codexRequest(payload: JsonObject, format: CodexRequestFormat = 'codex'): JsonObject {
  const result = {
    ...payload,
    ...Array.isArray(payload.tools) && payload.tools.length > 0 && payload.tool_choice === undefined ? { tool_choice: 'auto' } : {},
  }
  if (!Array.isArray(payload.input)) return result
  const [first, ...rest] = payload.input
  const item = object(first)
  if (item?.role !== 'developer' || (item.type !== undefined && item.type !== 'message') || typeof item.content !== 'string') return result
  if (format === 'codex-instructions') {
    return payload.instructions === undefined ? { ...result, instructions: item.content, input: rest } : result
  }
  return { ...result, input: [{ ...item, type: 'message', content: [{ type: 'input_text', text: item.content }] }, ...rest] }
}
