/** Host-only bundle entry. Existing providers, defaults and non-GPT models remain untouched. */
import type { Context } from '@deepseek-ai/cordis'
import { assertUsableApiKey, LlmError } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-credentials'
import { GatewayAdapter } from './adapter.ts'
import { Config, resolveRoutes } from './config.ts'

export { Config } from './config.ts'
export const name = 'dsh-websocket'
export const inject = ['llm', 'credentials']

/**
 * Register independently named GPT routes with request-owned network resources.
 * @param ctx - Cordis owner providing LLM and credential services.
 * @param config - validated gateway declarations; empty leaves the profile unchanged.
 */
export function apply(ctx: Context, config: Config): void {
  const routes = resolveRoutes(config)
  if (routes.size === 0) return
  const adapter = new GatewayAdapter(routes, {
    resolveApiKey: async (provider, profile) => {
      if (profile.apiKeyEnv === undefined) throw new LlmError(`GPT gateway "${provider}" has no credential reference.`, 'MISSING_CREDENTIAL')
      const credential = await ctx.credentials.resolve(profile.apiKeyEnv)
      if (credential === undefined) throw new LlmError(`Set the configured credential reference for GPT gateway "${provider}" before requesting its models.`, 'MISSING_CREDENTIAL')
      return assertUsableApiKey(credential.value, name, profile.apiKeyEnv)
    },
    resolveAttachments: () => ctx.get('attachments'),
    prepareHeaders: (request, headers) => ctx.waterfall('llm-pi-ai/request-headers', request, headers, () => headers),
    onReplayDegrade: ({ provider, model }) => ctx.logger.warn(`GPT gateway ${provider}/${model}: unusable native replay metadata; sending provider-neutral history.`),
    report: (provider, event) => {
      const text = `GPT gateway ${provider}: ${event.transport} ${event.phase}${event.code === undefined ? '' : ` (${event.code})`}`
      if (event.phase === 'fallback') ctx.logger.warn(text)
      else ctx.logger.info(text)
    },
  })
  ctx.effect(() => async () => { await adapter.dispose() }, 'dsh-websocket: cancel and drain model requests')
  ctx.llm.registerAdapter([...routes.keys()], adapter)
}
