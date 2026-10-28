const DEFAULT_MAX_TOKENS = 2600

export function llmReady(ctx) {
  try {
    return Boolean(ctx.get('llm') && ctx.get('agentDefaultModel'))
  } catch {
    return false
  }
}

export function currentModel(ctx) {
  const selection = ctx.get('agentDefaultModel')
  if (!selection) return null
  try {
    const value = selection.currentSelection()
    if (!value?.provider || !value?.model) return null
    return { provider: value.provider, model: value.model }
  } catch {
    return null
  }
}

async function once(ctx, options) {
  const llm = ctx.get('llm')
  const model = currentModel(ctx)
  if (!llm || !model) throw new Error('当前配置没有可用的默认模型（llm / agentDefaultModel 不可用）')

  const { system, prompt, maxTokens, temperature, signal, sessionId } = options
  // `llm.stream` resolves adapters and materializes defaults itself. Preparing a call and then
  // passing different controls trips the INVALID_PREPARED_CALL guard, so dispatch plainly.
  const stream = llm.stream({
    provider: model.provider,
    model: model.model,
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: String(prompt ?? '') }] }],
    maxTokens,
    temperature,
    signal,
    sessionId,
  })

  let text = ''
  let finish = ''
  let failure = null
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') text += chunk.text
    else if (chunk.type === 'finish') {
      finish = chunk.reason?.kind ?? ''
      if (finish === 'error' || finish === 'aborted') failure = chunk.reason?.failure ?? { message: finish }
    }
  }
  return { text: text.trim(), finish, failure, model }
}

/**
 * One completion accumulated into a single string. An empty reply (a reasoning-heavy model can
 * burn the whole budget before emitting text) is retried once with a larger budget, then raised
 * as an error so callers fall back to rules instead of writing empty notes.
 */
export async function complete(ctx, options) {
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS
  const first = await once(ctx, { ...options, maxTokens })
  if (first.text) return first.text
  if (first.failure) throw new Error(`模型调用失败：${first.failure.message ?? first.failure.code ?? '未知错误'}`)

  const retryTokens = Math.max(maxTokens * 2, 5000)
  const second = await once(ctx, { ...options, maxTokens: retryTokens })
  if (second.text) return second.text
  if (second.failure) throw new Error(`模型调用失败：${second.failure.message ?? second.failure.code ?? '未知错误'}`)

  throw new Error(`模型返回空内容（finish=${second.finish || first.finish || 'unknown'}，maxTokens=${retryTokens}）`)
}

/** Parse the first JSON object in a model reply (fenced or bare). */
export function extractJson(text) {
  const source = String(text ?? '')
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(source)
  const candidate = fenced ? fenced[1] : source
  const start = candidate.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  let end = -1
  for (let i = start; i < candidate.length; i += 1) {
    const char = candidate[i]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  if (end < 0) return null
  try {
    return JSON.parse(candidate.slice(start, end + 1))
  } catch {
    return null
  }
}

export function asString(value, fallback = '') {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return fallback
}

export function asStringArray(value, limit = 12) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map((item) => asString(item)).filter(Boolean))].slice(0, limit)
}
