export type Language = 'zh' | 'en'

export type ProviderId = 'openai' | 'xai' | 'google' | 'cgu'
export type ReasoningEffort = 'low' | 'medium' | 'high'

export interface TranscriptSegment {
  id: string
  start: number
  end: number
  speaker?: string
  text: string
  originalText: string
  confidence?: number
}

export interface ReferenceDocument {
  id: string
  name: string
  type: 'pdf' | 'text'
  pages?: number
  text: string
  size: number
}

export interface GlossaryTerm {
  canonical: string
  aliases: string
  kind: '姓名' | '專案' | '產品' | '其他'
  locked: boolean
}

export interface ModelInfo {
  id: string
  displayName: string
  capabilities: string[]
  source: ProviderId
  created?: number
}

export interface ProviderConfig {
  id: ProviderId
  apiKey: string
  baseUrl?: string
  modelId?: string
  reasoningEffort?: ReasoningEffort
}

export interface GenerationResult {
  revisedText: string
  changes: Array<{ from: string; to: string; reason: string; confidence: 'high' | 'medium' | 'low' }>
  terms: Array<{ source: string; suggested: string; status: 'confirmed' | 'candidate' | 'uncertain'; evidence: string[] }>
  uncertainties: string[]
  evidence: Array<{ claim: string; source: string }>
}

export interface MeetingOutput {
  notice: string
  minutes: string
  actions: string
  agenda: string
  a4Html: string
}
