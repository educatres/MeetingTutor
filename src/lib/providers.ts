import type { ModelInfo, ProviderConfig, ProviderId } from '../types'

export const PROVIDERS: Array<{ id: ProviderId; label: string; defaultBaseUrl: string; hint: string }> = [
  { id: 'openai', label: 'OpenAI', defaultBaseUrl: 'https://api.openai.com/v1', hint: '支援 OpenAI 相容的 models 與 chat/completions。' },
  { id: 'xai', label: 'Grok（xAI）', defaultBaseUrl: 'https://api.x.ai/v1', hint: '以 xAI 的 OpenAI 相容 API 為基線。' },
  { id: 'google', label: 'Google Gemini', defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta', hint: '使用 Gemini models 與 generateContent。' },
  { id: 'cgu', label: 'CGU', defaultBaseUrl: 'https://air.cgu.edu.tw/cgullmapi/v1', hint: '使用 CGU LLM API v1；若瀏覽器遭到 CORS 阻擋，請依 CGU 服務政策處理。' },
]

const cleanBaseUrl = (value: string) => value.replace(/\/$/, '')

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // OpenAI-compatible APIs commonly return Unix seconds; normalize to ms.
    return value < 10_000_000_000 ? value * 1000 : value
  }
  if (typeof value === 'string') {
    const numeric = Number(value)
    if (Number.isFinite(numeric) && value.trim() !== '') return parseTimestamp(numeric)
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? undefined : parsed
  }
  return undefined
}

function modelTimestamp(model: any): number | undefined {
  for (const key of ['updated', 'updated_at', 'updatedAt', 'updateTime', 'created', 'created_at', 'createdAt', 'createTime']) {
    const parsed = parseTimestamp(model?.[key])
    if (parsed !== undefined) return parsed
  }
  return undefined
}

function lunaVersion(model: ModelInfo): number[] {
  const label = `${model.id} ${model.displayName}`
  const match = label.match(/luna[^0-9]*(\d+(?:\.\d+)*)/i)
  if (!match) return []
  return match[1].split('.').map((part) => Number(part))
}

function compareVersions(left: number[], right: number[]) {
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

function sortModels(config: ProviderConfig, models: ModelInfo[]): ModelInfo[] {
  if (config.id !== 'cgu') return models
  return models
    .map((model, index) => ({ model, index, luna: /luna/i.test(`${model.id} ${model.displayName}`) }))
    .sort((left, right) => {
      // CGU's Luna family is the preferred default. The API's timestamp (when
      // supplied) wins; a semantic version then provides a useful fallback.
      if (left.luna !== right.luna) return left.luna ? -1 : 1
      if (left.luna && right.luna) {
        const leftCreated = left.model.created ?? 0
        const rightCreated = right.model.created ?? 0
        if (leftCreated !== rightCreated) return rightCreated - leftCreated
        const versionDifference = compareVersions(lunaVersion(right.model), lunaVersion(left.model))
        if (versionDifference !== 0) return versionDifference
      }
      return left.index - right.index
    })
    .map(({ model }) => model)
}

async function request(url: string, init: RequestInit, timeoutMs = 30_000): Promise<Response> {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error(`API 請求超過 ${Math.round(timeoutMs / 1000)} 秒未完成，請稍後再試或改用較快的模型。`)
    }
    throw error
  } finally {
    window.clearTimeout(timeout)
  }
}

async function responseJson(response: Response): Promise<any> {
  const text = await response.text()
  let body: any = {}
  try { body = text ? JSON.parse(text) : {} } catch { body = { raw: text } }
  if (!response.ok) {
    const message = body?.error?.message || body?.message || body?.raw || `HTTP ${response.status}`
    throw new Error(`${response.status}: ${message}`)
  }
  return body
}

function authHeaders(key: string): HeadersInit {
  return { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
}

export function providerLabel(id: ProviderId) {
  return PROVIDERS.find((provider) => provider.id === id)?.label ?? id
}

export async function listModels(config: ProviderConfig): Promise<ModelInfo[]> {
  if (!config.apiKey.trim()) throw new Error('請先輸入 API Key。')
  if (config.id === 'google') {
    const base = cleanBaseUrl(config.baseUrl || 'https://generativelanguage.googleapis.com/v1beta')
    const body = await responseJson(await request(`${base}/models?key=${encodeURIComponent(config.apiKey)}`, { method: 'GET' }))
    const models = (body.models ?? []).filter((model: any) => (model.supportedGenerationMethods ?? []).includes('generateContent')).map((model: any) => ({
      id: String(model.name ?? '').replace(/^models\//, ''),
      displayName: model.displayName || model.name,
      capabilities: ['text-generation'],
      source: 'google' as const,
      created: modelTimestamp(model),
    }))
    return sortModels(config, models)
  }
  const base = cleanBaseUrl(config.baseUrl || PROVIDERS.find((p) => p.id === config.id)?.defaultBaseUrl || '')
  const body = await responseJson(await request(`${base}/models`, { method: 'GET', headers: authHeaders(config.apiKey) }))
  const rows = Array.isArray(body) ? body : body.data ?? body.models ?? []
  const models = rows.map((model: any) => {
    const id = String(model.id ?? model.name ?? '')
    return { id: id.replace(/^models\//, ''), displayName: model.displayName || id, capabilities: ['text-generation'], source: config.id, created: modelTimestamp(model) }
  }).filter((model: ModelInfo) => model.id)
  return sortModels(config, models)
}

function responsesText(body: any): string {
  if (typeof body?.output_text === 'string') return body.output_text
  if (!Array.isArray(body?.output)) return ''
  return body.output.flatMap((item: any) => Array.isArray(item?.content) ? item.content : [])
    .map((part: any) => typeof part?.text === 'string' ? part.text : '')
    .join('')
}

export async function generateText(config: ProviderConfig, prompt: string, systemPrompt = ''): Promise<string> {
  if (!config.apiKey.trim() || !config.modelId) throw new Error('請先測試 API Key 並選擇模型。')
  const model = config.modelId
  const instructions = systemPrompt.trim()
  if (config.id === 'google') {
    const base = cleanBaseUrl(config.baseUrl || 'https://generativelanguage.googleapis.com/v1beta')
    const requestBody: Record<string, unknown> = { contents: [{ role: 'user', parts: [{ text: prompt }] }] }
    if (instructions) requestBody.systemInstruction = { parts: [{ text: instructions }] }
    const body = await responseJson(await request(`${base}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(config.apiKey)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(requestBody),
    }, 120_000))
    const text = body.candidates?.[0]?.content?.parts?.map((part: any) => part.text || '').join('') || ''
    if (!text) throw new Error('模型已回應，但沒有可讀取的文字內容。')
    return text
  }
  if (config.id === 'cgu' && !config.baseUrl?.trim()) {
    throw new Error('CGU endpoint 未設定，因此未送出資料。')
  }
  const base = cleanBaseUrl(config.baseUrl || PROVIDERS.find((p) => p.id === config.id)?.defaultBaseUrl || '')
  if (config.id === 'cgu' && /luna/i.test(model)) {
    const requestBody: Record<string, unknown> = { model, input: prompt, max_output_tokens: 4096, reasoning: { effort: config.reasoningEffort ?? 'medium' } }
    if (instructions) requestBody.instructions = instructions
    const body = await responseJson(await request(`${base}/responses`, {
      method: 'POST',
      headers: authHeaders(config.apiKey),
      body: JSON.stringify(requestBody),
    }, 120_000))
    const text = responsesText(body)
    if (!text) throw new Error('模型已回應，但沒有可讀取的文字內容。')
    return text
  }
  const messages = instructions
    ? [{ role: 'system', content: instructions }, { role: 'user', content: prompt }]
    : [{ role: 'user', content: prompt }]
  const requestBody: Record<string, unknown> = { model, messages }
  if (config.id === 'cgu') {
    requestBody.max_completion_tokens = 4096
  } else {
    requestBody.temperature = 0.1
  }
  const body = await responseJson(await request(`${base}/chat/completions`, {
    method: 'POST', headers: authHeaders(config.apiKey), body: JSON.stringify(requestBody),
  }, 120_000))
  const text = body.choices?.[0]?.message?.content || ''
  if (!text) throw new Error('模型已回應，但沒有可讀取的文字內容。')
  return text
}
