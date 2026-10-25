import type { GenerationResult, ModelInfo, ProviderConfig, ProviderId } from '../types'

export const PROVIDERS: Array<{ id: ProviderId; label: string; defaultBaseUrl: string; hint: string }> = [
  { id: 'openai', label: 'OpenAI', defaultBaseUrl: 'https://api.openai.com/v1', hint: '支援 OpenAI 相容的 models 與 chat/completions。' },
  { id: 'xai', label: 'Grok（xAI）', defaultBaseUrl: 'https://api.x.ai/v1', hint: '以 xAI 的 OpenAI 相容 API 為基線。' },
  { id: 'google', label: 'Google Gemini', defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta', hint: '使用 Gemini models 與 generateContent。' },
  { id: 'cgu', label: 'CGU', defaultBaseUrl: 'https://air.cgu.edu.tw/cgullmapi/v1', hint: '使用 CGU LLM API v1；若瀏覽器遭到 CORS 阻擋，請依 CGU 服務政策處理。' },
]

const cleanBaseUrl = (value: string) => value.replace(/\/$/, '')

async function request(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), 30_000)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
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
    return (body.models ?? []).filter((model: any) => (model.supportedGenerationMethods ?? []).includes('generateContent')).map((model: any) => ({
      id: String(model.name ?? '').replace(/^models\//, ''),
      displayName: model.displayName || model.name,
      capabilities: ['text-generation'],
      source: 'google' as const,
    }))
  }
  const base = cleanBaseUrl(config.baseUrl || PROVIDERS.find((p) => p.id === config.id)?.defaultBaseUrl || '')
  const body = await responseJson(await request(`${base}/models`, { method: 'GET', headers: authHeaders(config.apiKey) }))
  const rows = Array.isArray(body) ? body : body.data ?? body.models ?? []
  return rows.map((model: any) => {
    const id = String(model.id ?? model.name ?? '')
    return { id: id.replace(/^models\//, ''), displayName: model.displayName || id, capabilities: ['text-generation'], source: config.id }
  }).filter((model: ModelInfo) => model.id)
}

function parseJsonResult(text: string): GenerationResult {
  const match = text.match(/\{[\s\S]*\}/)
  if (match) {
    try {
      const parsed = JSON.parse(match[0])
      return {
        revisedText: String(parsed.revisedText ?? text),
        changes: Array.isArray(parsed.changes) ? parsed.changes : [],
        terms: Array.isArray(parsed.terms) ? parsed.terms : [],
        uncertainties: Array.isArray(parsed.uncertainties) ? parsed.uncertainties : [],
        evidence: Array.isArray(parsed.evidence) ? parsed.evidence : [],
      }
    } catch { /* fall through to safe text result */ }
  }
  return { revisedText: text, changes: [], terms: [], uncertainties: ['模型未回傳可解析的結構化 JSON，已保留原始模型輸出。'], evidence: [] }
}

export async function generateText(config: ProviderConfig, prompt: string): Promise<GenerationResult> {
  if (!config.apiKey.trim() || !config.modelId) throw new Error('請先測試 API Key 並選擇模型。')
  const model = config.modelId
  if (config.id === 'google') {
    const base = cleanBaseUrl(config.baseUrl || 'https://generativelanguage.googleapis.com/v1beta')
    const body = await responseJson(await request(`${base}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(config.apiKey)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }] }),
    }))
    const text = body.candidates?.[0]?.content?.parts?.map((part: any) => part.text || '').join('') || ''
    return parseJsonResult(text)
  }
  if (config.id === 'cgu' && !config.baseUrl?.trim()) {
    throw new Error('CGU endpoint 未設定，因此未送出資料。')
  }
  const base = cleanBaseUrl(config.baseUrl || PROVIDERS.find((p) => p.id === config.id)?.defaultBaseUrl || '')
  const body = await responseJson(await request(`${base}/chat/completions`, {
    method: 'POST', headers: authHeaders(config.apiKey), body: JSON.stringify({ model, temperature: 0.1, messages: [{ role: 'user', content: prompt }] }),
  }))
  const text = body.choices?.[0]?.message?.content || ''
  return parseJsonResult(text)
}
