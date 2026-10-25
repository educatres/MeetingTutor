export type Language = 'zh' | 'en'
export type RecordTemplate = 'meeting' | 'class' | 'memo' | 'experiment' | 'journal'

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

export interface GlossarySuggestion {
  original: string
  suggested: string
  reason: string
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

export interface MeetingOutput {
  minutes: string
  actions?: string
  agenda?: string
}
