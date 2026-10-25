import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import './styles.css'
import type { GlossarySuggestion, GlossaryTerm, Language, MeetingOutput, ModelInfo, ProviderConfig, ProviderId, ReasoningEffort, RecordTemplate, ReferenceDocument, TranscriptSegment } from './types'
import { PROVIDERS, generateText, isAllowedTextModel, listModels, providerLabel } from './lib/providers'
import { readReference } from './lib/references'
import { cleanPlainTextOutput, createGlossaryPrompt, createPolishedTranscriptPrompt, createPrompt, extractPlainTextSection, parseGlossarySuggestions, parsePolishedTranscript } from './lib/outputs'
import { transcribe } from './lib/transcription'
import { parseTeamsTranscript } from './lib/transcript'

const defaultProvider: ProviderId = 'openai'
const API_KEYS_STORAGE_KEY = 'meetingtutor.api-keys.v1'
const MODEL_CONFIG_STORAGE_KEY = 'meetingtutor.model-config.v1'
const SYSTEM_PROMPT_STORAGE_KEY = 'meetingtutor.ai-system-prompt.v1'

function storedApiKeys(): Partial<Record<ProviderId, string>> {
  try {
    const raw = window.localStorage.getItem(API_KEYS_STORAGE_KEY)
    return raw ? JSON.parse(raw) as Partial<Record<ProviderId, string>> : {}
  } catch { return {} }
}

function storedApiKey(provider: ProviderId) {
  return storedApiKeys()[provider] ?? ''
}

function storedSystemPrompt() {
  try { return window.localStorage.getItem(SYSTEM_PROMPT_STORAGE_KEY) ?? '' } catch { return '' }
}

function initialProviderConfig(): ProviderConfig {
  try {
    const raw = window.localStorage.getItem(MODEL_CONFIG_STORAGE_KEY)
    const saved = raw ? JSON.parse(raw) as Partial<ProviderConfig> : {}
    const id = PROVIDERS.some((provider) => provider.id === saved.id) ? saved.id as ProviderId : defaultProvider
    const provider = PROVIDERS.find((item) => item.id === id)!
    const modelId = typeof saved.modelId === 'string' && isAllowedTextModel(saved.modelId) ? saved.modelId : undefined
    return {
      id,
      apiKey: storedApiKey(id),
      baseUrl: typeof saved.baseUrl === 'string' ? saved.baseUrl : provider.defaultBaseUrl,
      modelId,
      reasoningEffort: saved.reasoningEffort === 'low' || saved.reasoningEffort === 'medium' || saved.reasoningEffort === 'high' ? saved.reasoningEffort : id === 'cgu' ? 'medium' : undefined,
    }
  } catch {
    return { id: defaultProvider, apiKey: storedApiKey(defaultProvider), baseUrl: PROVIDERS[0].defaultBaseUrl }
  }
}

function formatSeconds(seconds: number) {
  if (seconds < 0) return '--:--'
  const minutes = Math.floor(seconds / 60).toString().padStart(2, '0')
  const rest = Math.floor(seconds % 60).toString().padStart(2, '0')
  return `${minutes}:${rest}`
}

function transcriptTextForDownload(segments: TranscriptSegment[]) {
  return segments.map((segment) => {
    const speaker = segment.speaker ? `｜${segment.speaker}` : ''
    return `[${formatSeconds(segment.start)}${speaker}] ${segment.text}`
  }).join('\n')
}

function formatSrtTime(seconds: number) {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0)
  const hours = Math.floor(safe / 3600).toString().padStart(2, '0')
  const minutes = Math.floor((safe % 3600) / 60).toString().padStart(2, '0')
  const rest = safe % 60
  const wholeSeconds = Math.floor(rest).toString().padStart(2, '0')
  const milliseconds = Math.floor((rest - Math.floor(rest)) * 1000).toString().padStart(3, '0')
  return `${hours}:${minutes}:${wholeSeconds},${milliseconds}`
}

function subtitleTextForDownload(segments: TranscriptSegment[]) {
  return segments.map((segment, index) => {
    const nextStart = segments[index + 1]?.start
    const end = segment.end > segment.start ? segment.end : (typeof nextStart === 'number' && nextStart > segment.start ? nextStart : segment.start + 2)
    return `${index + 1}\n${formatSrtTime(segment.start)} --> ${formatSrtTime(end)}\n${segment.text}\n`
  }).join('\n')
}

function downloadTextFile(name: string, content: string) {
  const url = URL.createObjectURL(new Blob([`\uFEFF${content}`], { type: 'text/plain;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

type ModelTestStatus = 'idle' | 'testing' | 'available' | 'empty' | 'error'
type GenerationStatus = { kind: 'working' | 'success' | 'error'; message: string }
const RECORD_TEMPLATE_OPTIONS: Array<{ id: RecordTemplate; label: string; headings: string }> = [
  { id: 'meeting', label: '會議記錄摘要', headings: '會議摘要、討論重點、決議事項、待辦事項、後續安排' },
  { id: 'class', label: '上課錄音／課堂筆記', headings: '課程摘要、學習目標、核心概念、主題重點、例子、作業與待釐清問題' },
  { id: 'memo', label: '工作備忘錄', headings: '重點摘要、目前進度、待處理事項、重要決定、後續追蹤' },
  { id: 'experiment', label: '口述實驗記錄', headings: '實驗目的、材料設備、操作步驟、觀察結果、異常原因、結論' },
  { id: 'journal', label: '個人日誌', headings: '事件與經過、想法與感受、重要收穫、待辦與明日計畫' },
]

function recordTemplateLabel(template: RecordTemplate) {
  return RECORD_TEMPLATE_OPTIONS.find((item) => item.id === template)?.label ?? template
}

const SYSTEM_PROMPT_EXAMPLES = [
  { label: '正式會議紀錄', prompt: '請將口語內容整理為正式、精簡的繁體中文，保留原意與各方立場，不新增逐字稿未提及的事實。', template: 'meeting' as const },
  { label: '決議與待辦優先', prompt: '請優先整理會議決議、待辦事項、負責人、期限與未決問題；逐字稿沒有明確資訊時請標示「待確認」，不要自行推測。', template: 'meeting' as const },
  { label: '專有名詞保守修正', prompt: '請依照已確認詞彙與參考資料修正人名、組織名及專有名詞；缺乏依據時保留原文並列入待確認事項。' },
  { label: '保留講者語氣', prompt: '請修正文法、贅詞與重複語句，但保留講者原本的語氣、觀點與不同意見，不要過度改寫。' },
  { label: '上課錄音', prompt: '請將上課錄音整理成結構清楚的課堂筆記，依主題分段，保留教師講解的定義、核心概念、例子、重點提醒與作業要求；移除口頭贅詞，但不得補充錄音未提及的內容，不確定的術語請標示「待確認」。', template: 'class' as const },
]

export default function App() {
  const [language, setLanguage] = useState<Language>('zh')
  const [whisperModel, setWhisperModel] = useState<'tiny' | 'base' | 'medium'>('base')
  const [audioFile, setAudioFile] = useState<File | null>(null)
  const [transcriptFile, setTranscriptFile] = useState<File | null>(null)
  const [uploadedTranscriptSegments, setUploadedTranscriptSegments] = useState<TranscriptSegment[]>([])
  const [recording, setRecording] = useState(false)
  const [mediaRecorder, setMediaRecorder] = useState<MediaRecorder | null>(null)
  const [segments, setSegments] = useState<TranscriptSegment[]>([])
  const [references, setReferences] = useState<ReferenceDocument[]>([])
  const [glossary, setGlossary] = useState<GlossaryTerm[]>([])
  const [glossarySuggestions, setGlossarySuggestions] = useState<Array<GlossarySuggestion & { id: string }>>([])
  const [glossaryStatus, setGlossaryStatus] = useState<string | null>(null)
  const [newTermText, setNewTermText] = useState('')
  const [config, setConfig] = useState<ProviderConfig>(initialProviderConfig)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [modelTestStatus, setModelTestStatus] = useState<ModelTestStatus>('idle')
  const [systemPrompt, setSystemPrompt] = useState(storedSystemPrompt)
  const [status, setStatus] = useState('狀態/進度')
  const [busy, setBusy] = useState(false)
  const [output, setOutput] = useState<MeetingOutput | null>(null)
  const [polishedSegments, setPolishedSegments] = useState<TranscriptSegment[]>([])
  const [generationStatus, setGenerationStatus] = useState<GenerationStatus | null>(null)
  const [recordTemplate, setRecordTemplate] = useState<RecordTemplate>(() => storedSystemPrompt().includes('上課錄音') ? 'class' : 'meeting')
  const [generatedTemplate, setGeneratedTemplate] = useState<RecordTemplate>('meeting')
  const [includeActions, setIncludeActions] = useState(false)
  const [includeAgenda, setIncludeAgenda] = useState(false)
  const [templateHelpOpen, setTemplateHelpOpen] = useState(false)
  const [hardwareResult, setHardwareResult] = useState<string | null>(null)
  const [showKey, setShowKey] = useState(false)
  const [testPreviewOpen, setTestPreviewOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(() => {
    const saved = initialProviderConfig()
    return !saved.apiKey || !saved.modelId
  })
  const liveTranscriptRef = useRef<HTMLDivElement | null>(null)
  const outputResultRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    try {
      const keys = storedApiKeys()
      keys[config.id] = config.apiKey
      window.localStorage.setItem(API_KEYS_STORAGE_KEY, JSON.stringify(keys))
    } catch { /* Private browsing or blocked storage: keep the key in memory only. */ }
  }, [config.id, config.apiKey])

  useEffect(() => {
    try {
      window.localStorage.setItem(MODEL_CONFIG_STORAGE_KEY, JSON.stringify({ id: config.id, baseUrl: config.baseUrl, modelId: config.modelId, reasoningEffort: config.reasoningEffort }))
    } catch { /* Private browsing or blocked storage: keep the model settings in memory only. */ }
  }, [config.id, config.baseUrl, config.modelId, config.reasoningEffort])

  useEffect(() => {
    try {
      if (systemPrompt) window.localStorage.setItem(SYSTEM_PROMPT_STORAGE_KEY, systemPrompt)
      else window.localStorage.removeItem(SYSTEM_PROMPT_STORAGE_KEY)
    } catch { /* Private browsing or blocked storage: keep the prompt in memory only. */ }
  }, [systemPrompt])

  useEffect(() => {
    const box = liveTranscriptRef.current
    if (box) box.scrollTop = box.scrollHeight
  }, [segments])

  useEffect(() => {
    if (output) outputResultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [output])

  const transcriptText = useMemo(() => segments.map((segment) => segment.text).join(' '), [segments])

  const checkHardware = async () => {
    const cores = navigator.hardwareConcurrency ?? 0
    const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory
    let availableStorageGb: number | null = null
    if (navigator.storage?.estimate) {
      const estimate = await navigator.storage.estimate()
      if (estimate.quota !== undefined) availableStorageGb = Math.max(0, (estimate.quota - (estimate.usage ?? 0)) / 1024 ** 3)
    }
    const cpuOk = cores >= 4
    const memoryOk = memory === undefined || memory >= 8
    const storageOk = availableStorageGb === null || availableStorageGb >= 2
    const missing = [
      !cpuOk ? `CPU ${cores || '未知'} 核（建議至少 4 核）` : '',
      memory !== undefined && !memoryOk ? `記憶體約 ${memory} GB（建議至少 8 GB）` : '',
      availableStorageGb !== null && !storageOk ? `瀏覽器可用儲存配額約 ${availableStorageGb.toFixed(1)} GB（建議至少 2 GB）` : '',
    ].filter(Boolean)
    const webgpu = 'gpu' in navigator ? 'WebGPU 可用' : 'WebGPU 不可用，將使用 WASM'
    setHardwareResult(missing.length ? `未完全符合最低建議：${missing.join('；')}。${webgpu}。仍可嘗試 Whisper-tiny。` : `符合最低建議（CPU ${cores || '未知'} 核${memory !== undefined ? `、記憶體約 ${memory} GB` : ''}）。${webgpu}。`)
  }

  const updateProvider = (id: ProviderId) => {
    const provider = PROVIDERS.find((item) => item.id === id)!
    setConfig({ id, apiKey: storedApiKey(id), baseUrl: provider.defaultBaseUrl, modelId: undefined, reasoningEffort: id === 'cgu' ? 'medium' : undefined })
    setModels([])
    setModelTestStatus('idle')
  }

  const updateApiKey = (apiKey: string) => {
    setConfig((current) => ({ ...current, apiKey, modelId: undefined }))
    setModels([])
    setModelTestStatus('idle')
  }

  const updateBaseUrl = (baseUrl: string) => {
    setConfig((current) => ({ ...current, baseUrl, modelId: undefined }))
    setModels([])
    setModelTestStatus('idle')
  }

  const onAudioChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null
    setAudioFile(file)
    setSegments([])
    setPolishedSegments([])
    if (file) {
      setTranscriptFile(null)
      setUploadedTranscriptSegments([])
    }
    setStatus(file ? `已選擇：${file.name}` : '狀態/進度')
  }

  const onTranscriptChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null
    setTranscriptFile(file)
    setUploadedTranscriptSegments([])
    setSegments([])
    setPolishedSegments([])
    if (!file) return
    setAudioFile(null)
    setBusy(true)
    try {
      const parsed = parseTeamsTranscript(await file.text())
      if (!parsed.length) throw new Error('找不到可辨識的逐字稿內容。')
      setUploadedTranscriptSegments(parsed)
      setStatus(`已解析 Teams 逐字稿：${file.name}，共 ${parsed.length} 段；按下「載入逐字稿」後開始使用。`)
    } catch (error) {
      setTranscriptFile(null)
      setStatus(`逐字稿解析失敗：${error instanceof Error ? error.message : String(error)}`)
    } finally { setBusy(false) }
  }

  const startRecording = async () => {
    try {
      setTranscriptFile(null)
      setUploadedTranscriptSegments([])
      setSegments([])
      setPolishedSegments([])
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const recorder = new MediaRecorder(stream)
      const chunks: Blob[] = []
      recorder.ondataavailable = (event) => chunks.push(event.data)
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop())
        setAudioFile(new File(chunks, `meeting-${new Date().toISOString().slice(0, 10)}.webm`, { type: recorder.mimeType || 'audio/webm' }))
        setStatus('錄音完成，請按「開始轉錄」。')
      }
      recorder.start()
      setMediaRecorder(recorder)
      setRecording(true)
      setStatus('錄音中…再次按下按鈕停止。')
    } catch (error) {
      setStatus(`無法使用麥克風：${error instanceof Error ? error.message : '請檢查瀏覽器權限。'}`)
    }
  }

  const stopRecording = () => {
    mediaRecorder?.stop()
    setRecording(false)
    setMediaRecorder(null)
  }

  const updateSegment = (id: string, text: string) => {
    setSegments((current) => current.map((segment) => segment.id === id ? { ...segment, text } : segment))
  }

  const downloadTranscript = () => {
    if (!segments.length) return
    const baseName = audioFile?.name.replace(/\.[^.]+$/, '') || `meeting-${new Date().toISOString().slice(0, 10)}`
    downloadTextFile(`${baseName}-逐字稿.txt`, transcriptTextForDownload(segments))
    setStatus('逐字稿已下載。')
  }

  const downloadPolishedTranscript = () => {
    if (!polishedSegments.length) return
    const sourceName = audioFile?.name || transcriptFile?.name
    const baseName = sourceName?.replace(/\.[^.]+$/, '') || `meeting-${new Date().toISOString().slice(0, 10)}`
    downloadTextFile(`${baseName}-YouTube字幕.srt`, subtitleTextForDownload(polishedSegments))
    setStatus('YouTube 字幕檔已下載。')
  }

  const runTranscription = async () => {
    if (uploadedTranscriptSegments.length) {
      setSegments(uploadedTranscriptSegments)
      setStatus(`已載入逐字稿，共 ${uploadedTranscriptSegments.length} 個段落。`)
      return
    }
    if (!audioFile) return setStatus('請先選擇音訊檔、完成錄音，或上傳 Teams 逐字稿。')
    setBusy(true)
    setStatus('正在讀取音訊並準備模型…')
    try {
      const result = await transcribe(audioFile, language, whisperModel, (progress) => {
        const phase = progress.phase ?? (progress.status?.includes('辨識') ? 'transcribing' : 'model')
        const hasProgress = typeof progress.progress === 'number' && Number.isFinite(progress.progress)
        const value = hasProgress ? Math.min(100, Math.max(0, progress.progress ?? 0)) : 0
        const percent = !progress.indeterminate && hasProgress ? ` ${Math.round(value)}%` : ''
        setStatus(`${progress.status ?? '處理中…'}${percent}`)
      }, (partialSegments) => setSegments(partialSegments))
      setSegments(result)
      setStatus(`完成轉錄，共 ${result.length} 個段落。`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setStatus(message.toLowerCase().includes('fetch')
        ? '轉錄失敗：無法下載 Whisper 模型檔（Failed to fetch）。請確認網路連線、重新整理頁面，或先改用 Whisper-tiny。'
        : `轉錄失敗：${message}`)
    } finally {
      setBusy(false)
    }
  }

  const addReferences = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    if (!files.length) return
    setBusy(true)
    try {
      const parsed = await Promise.all(files.map(readReference))
      setReferences((current) => [...current, ...parsed])
      setStatus(`已加入 ${parsed.length} 份參考資料。`)
    } catch (error) {
      setStatus(`讀取參考資料失敗：${error instanceof Error ? error.message : String(error)}`)
    } finally { setBusy(false) }
  }

  const testProvider = async () => {
    setBusy(true)
    setModelTestStatus('testing')
    setStatus(`正在測試 ${providerLabel(config.id)} 並讀取模型…`)
    try {
      const result = await listModels(config)
      const selectedModelId = result.some((model) => model.id === config.modelId) ? config.modelId : result[0]?.id
      setModels(result)
      setConfig((current) => ({ ...current, modelId: selectedModelId }))
      setModelTestStatus(result.length ? 'available' : 'empty')
      setStatus(result.length ? `模型可用：已讀取 ${result.length} 個模型。${config.id === 'cgu' && /luna/i.test(`${result[0].id} ${result[0].displayName}`) ? `預設選擇最新 Luna：${result[0].displayName}` : ''}` : '測試成功，但 provider 沒有回傳可列舉的模型。')
    } catch (error) {
      setModels([])
      setModelTestStatus('error')
      setSettingsOpen(true)
      setStatus(`Provider 測試失敗：${error instanceof Error ? error.message : String(error)}；請檢查 Key、Base URL、CORS 或服務狀態。`)
    } finally { setBusy(false) }
  }

  const clearApiKeys = () => {
    try { window.localStorage.removeItem(API_KEYS_STORAGE_KEY) } catch { /* Keep going if storage is unavailable. */ }
    setConfig((current) => ({ ...current, apiKey: '', modelId: undefined }))
    setModels([])
    setModelTestStatus('idle')
    setSettingsOpen(true)
    setStatus('已清除瀏覽器中保存的 API Key。')
  }

  const addTerm = () => {
    const terms = newTermText.split(/[\n,，、;；]+/).map((term) => term.trim()).filter(Boolean)
    if (!terms.length) return
    setGlossary((current) => [...current, ...terms.filter((term) => !current.some((item) => item.canonical === term)).map((canonical) => ({ canonical, aliases: '', kind: '其他' as const, locked: true }))])
    setNewTermText('')
  }

  const refineGlossary = async () => {
    if (!segments.length) {
      setGlossaryStatus('請先上傳並載入逐字稿。')
      return
    }
    if (!config.apiKey.trim() || !config.modelId) {
      setGlossaryStatus('請先完成 AI 設定並測試模型。')
      setSettingsOpen(true)
      return
    }
    setBusy(true)
    setGlossaryStatus('AI 正在從逐字稿整理詞彙建議…')
    try {
      const response = await generateText(config, createGlossaryPrompt(segments, glossary, language), systemPrompt)
      const suggestions = parseGlossarySuggestions(response).map((suggestion) => ({ ...suggestion, id: crypto.randomUUID() }))
      setGlossarySuggestions(suggestions)
      setGlossaryStatus(suggestions.length ? `已找到 ${suggestions.length} 個詞彙建議，紅色文字可編輯。` : '模型沒有找到需要修正的詞彙。')
    } catch (error) {
      setGlossaryStatus(`詞彙校正失敗：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const updateGlossarySuggestion = (id: string, suggested: string) => {
    setGlossarySuggestions((current) => current.map((item) => item.id === id ? { ...item, suggested } : item))
  }

  const restoreGlossarySuggestion = (id: string) => {
    setGlossarySuggestions((current) => current.map((item) => item.id === id ? { ...item, suggested: item.original } : item))
  }

  const acceptGlossarySuggestion = (suggestion: GlossarySuggestion & { id: string }) => {
    const canonical = suggestion.suggested.trim()
    if (!canonical) return
    setGlossary((current) => current.some((item) => item.canonical === canonical) ? current : [...current, { canonical, aliases: suggestion.original, kind: '其他' as const, locked: false }])
    setGlossarySuggestions((current) => current.filter((item) => item.id !== suggestion.id))
  }

  const changeRecordTemplate = (template: RecordTemplate) => {
    setRecordTemplate(template)
    if (template !== 'meeting') {
      setIncludeActions(false)
      setIncludeAgenda(false)
    }
  }

  const addSystemPromptExample = (example: { prompt: string; template?: RecordTemplate }) => {
    if (example.template) changeRecordTemplate(example.template)
    setSystemPrompt((current) => {
      const existing = current.trim()
      if (existing.includes(example.prompt)) return current
      return `${existing ? `${existing}\n\n` : ''}${example.prompt}`.slice(0, 6000)
    })
  }

  const generate = async () => {
    if (!segments.length) {
      const message = '請先完成轉錄或載入逐字稿。'
      setGenerationStatus({ kind: 'error', message })
      setStatus(message)
      return
    }
    if (!config.apiKey.trim() || !config.modelId) {
      const message = '請先開啟頁首的「AI 設定」，測試 API Key 並選擇模型。'
      setGenerationStatus({ kind: 'error', message })
      setStatus(message)
      setSettingsOpen(true)
      return
    }
    setBusy(true)
    setGenerationStatus({ kind: 'working', message: `正在使用 ${config.modelId} 整理${recordTemplateLabel(recordTemplate)}，請稍候…` })
    try {
      const prompt = createPrompt(segments, references, glossary, language, recordTemplate)
      const generatedText = await generateText(config, prompt, systemPrompt)
      const minutes = cleanPlainTextOutput(generatedText || transcriptText)
      let polished = segments
      try {
        const polishedResponse = await generateText(config, createPolishedTranscriptPrompt(segments, language), systemPrompt)
        polished = parsePolishedTranscript(polishedResponse, segments)
      } catch {
        polished = segments
      }
      setPolishedSegments(polished)
      const actions = includeActions ? extractPlainTextSection(minutes, ['待辦事項', '待辦', '行動項目']) || undefined : undefined
      const agenda = includeAgenda ? extractPlainTextSection(minutes, ['下次會議議程', '下次議程', '後續安排']) || undefined : undefined
      setOutput({ minutes, actions, agenda })
      setGeneratedTemplate(recordTemplate)
      const message = '整理完成，成果已直接顯示在下方。'
      setGenerationStatus({ kind: 'success', message })
      setStatus(message)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      const readableDetail = /failed to fetch|load failed|networkerror/i.test(detail)
        ? '瀏覽器無法連線到模型 API；請確認網路、API Base URL，以及服務是否允許此網站的 CORS 請求。'
        : detail
      const message = `整理失敗：${readableDetail}`
      setGenerationStatus({ kind: 'error', message })
      setStatus(message)
      setModelTestStatus('error')
      setSettingsOpen(true)
    } finally { setBusy(false) }
  }

  return <div className="app-shell">
    <header className="hero">
      <div className="hero-main"><div className="hero-heading-row"><div className="hero-title-block"><p className="eyebrow">MeetingTutor</p><h1>會議記錄、上課錄音助教</h1></div><div className="header-actions"><button className={config.apiKey && config.modelId ? 'settings-toggle is-ready' : 'settings-toggle'} type="button" onClick={() => setSettingsOpen(true)} aria-expanded={settingsOpen}><span>AI 設定</span><small>{config.apiKey && config.modelId ? `${providerLabel(config.id)}｜${config.modelId}` : '尚未完成設定'}</small></button></div></div>{hardwareResult && <p className="hardware-result" role="status">{hardwareResult}</p>}</div>
      {settingsOpen && <section className="ai-settings-panel" aria-label="AI 模型設定">
        <div className="settings-panel-heading"><div><h2>AI 模型設定</h2><p>設定會保存在此瀏覽器；連線正常時，下次開啟可直接沿用。</p></div></div>
        <div className="provider-grid"><label className="field"><span>Provider</span><select value={config.id} onChange={(e) => updateProvider(e.target.value as ProviderId)} disabled={busy}>{PROVIDERS.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}</select></label><label className="field"><span>API Key（保存在本機瀏覽器）</span><div className="key-input"><input type={showKey ? 'text' : 'password'} value={config.apiKey} onChange={(e) => updateApiKey(e.target.value)} autoComplete="off" placeholder="貼上你的 Key" disabled={busy} /><button type="button" onClick={() => setShowKey((value) => !value)}>{showKey ? '隱藏' : '顯示'}</button><button type="button" onClick={clearApiKeys} disabled={busy}>清除 API Key</button></div></label><label className="field"><span>API Base URL</span><input value={config.baseUrl ?? ''} onChange={(e) => updateBaseUrl(e.target.value)} disabled={busy} /></label>{config.id === 'cgu' && <label className="field"><span>CGU 推理程度（預設：中）</span><select value={config.reasoningEffort ?? 'medium'} onChange={(e) => setConfig((current) => ({ ...current, reasoningEffort: e.target.value as ReasoningEffort }))} disabled={busy}><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></label>}</div>
        <p className="hint">{PROVIDERS.find((provider) => provider.id === config.id)?.hint}</p><button className="secondary" onClick={testProvider} disabled={busy || !config.apiKey}>{busy ? '測試中…' : config.modelId ? '重新測試並更新模型' : '測試 Key 並讀取模型'}</button>{modelTestStatus === 'available' && <p className="model-available" role="status">模型可用（已讀取 {models.length} 個），設定已自動保存。</p>}{modelTestStatus === 'empty' && <p className="model-unavailable" role="status">測試成功，但沒有可列舉的模型。</p>}{modelTestStatus === 'error' && <p className="model-unavailable" role="alert">模型呼叫失敗，請檢查 Key、Base URL、模型或服務狀態。</p>}{config.modelId && !models.length && modelTestStatus !== 'error' && <p className="stored-model">已保存模型：{config.modelId}</p>}{models.length > 0 && <label className="field model-select"><span>選擇模型</span><select value={config.modelId ?? ''} onChange={(e) => setConfig({ ...config, modelId: e.target.value })}>{models.map((model) => <option key={model.id} value={model.id}>{model.displayName}（{model.id}）</option>)}</select></label>}
        <div className="settings-close-row"><button type="button" onClick={() => setSettingsOpen(false)}>關閉 AI 設定</button></div>
      </section>}
    </header>

    <main className="workspace">
      <section className="panel"><div className="section-heading"><span className="step">1</span><div><h2>上傳逐字稿</h2><p>建議使用 Teams 產生字幕，再上傳至本系統進行摘要與統整。</p></div><button className={testPreviewOpen ? 'test-preview-toggle is-active' : 'test-preview-toggle'} type="button" onClick={() => setTestPreviewOpen((current) => !current)} aria-expanded={testPreviewOpen}>測試離線轉寫</button></div>
        {testPreviewOpen && <section className="test-preview-panel" aria-label="測試離線轉寫">
          <div className="test-preview-heading"><div><h2>測試離線轉寫</h2><p>需要測試瀏覽器端語音轉錄時，再從這裡上傳音訊或開始錄音。</p></div><button type="button" onClick={() => setTestPreviewOpen(false)}>關閉</button></div>
          <div className="test-preview-notice" role="note"><strong>建議先使用 Teams 產生字幕</strong><p>目前的語音模型僅在您的瀏覽器中執行，辨識精確度仍有限。此離線轉寫只適合發音較準確、背景雜訊少且較短的錄音檔案；建議先使用 Teams 錄音產生字幕，再將字幕上傳至本系統進行摘要與統整。</p></div>
          <div className="test-preview-hardware"><p className="hardware-note">最低硬體建議：四核心現代處理器、8 GB RAM、至少 2 GB 可用空間；建議使用最新版 Chrome、Edge 或 Firefox，WebGPU 可用時速度較佳。</p><button className="hardware-button" onClick={checkHardware}>檢測我的硬體</button></div>
          <div className="controls-row"><label className="field"><span>轉寫語言</span><select value={language} onChange={(event) => setLanguage(event.target.value as Language)} disabled={busy}><option value="zh">中文（繁體／多語模型）</option><option value="en">English（英文模型）</option></select></label><label className="field"><span>Whisper 模型</span><select value={whisperModel} onChange={(event) => setWhisperModel(event.target.value as 'tiny' | 'base' | 'medium')} disabled={busy}><option value="medium">Whisper-medium（最準確、需要較多記憶體）</option><option value="base">Whisper-base（預設，較準確）</option><option value="tiny">Whisper-tiny（較快、較省資源）</option></select></label><label className="file-picker"><span>選擇音訊</span><input type="file" accept="audio/*,video/*" onChange={onAudioChange} disabled={busy} /></label><button className="secondary" onClick={recording ? stopRecording : startRecording} disabled={busy}>{recording ? '停止錄音' : '開始錄音'}</button></div>
          {whisperModel === 'medium' && <p className="model-warning" role="alert">提醒：Whisper-medium 模型很大，需要電腦硬體足夠好才能跑完，處理過程可能中斷。</p>}
          {audioFile && <p className="file-note">已準備：{audioFile.name}（{Math.round(audioFile.size / 1024)} KB）</p>}
          <button className="primary" onClick={runTranscription} disabled={busy || !audioFile}>{busy ? '處理中…' : '開始轉錄'}</button>
          {audioFile && segments.length > 0 && !busy && <div className="transcript-actions"><button className="secondary" type="button" onClick={downloadTranscript}>下載逐字稿（TXT）</button></div>}
        </section>}
        <div className="controls-row transcript-upload-row"><label className="file-picker wide"><span>上傳 Teams 逐字稿（.vtt／.txt／.srt）</span><input type="file" accept=".vtt,.txt,.srt,text/vtt,text/plain" onChange={onTranscriptChange} disabled={busy} /></label></div>
        {transcriptFile && <p className="file-note">已準備 Teams 逐字稿：{transcriptFile.name}（{uploadedTranscriptSegments.length} 段）</p>}
        <div className="action-row-centered"><button className="primary" onClick={runTranscription} disabled={busy || !transcriptFile}>{busy ? '處理中…' : '載入逐字稿'}</button></div>
        <div className="live-transcript" aria-live="polite"><div className="live-transcript-heading"><strong>逐字稿內容（載入後可編修）</strong><span>{segments.length ? `目前 ${segments.length} 句` : '載入逐字稿後會顯示在這裡'}</span></div><div className="live-transcript-box" ref={liveTranscriptRef}>{segments.length ? segments.map((segment, index) => <div className="live-segment" key={segment.id}><span className="timestamp">{formatSeconds(segment.start)}</span><input type="text" value={segment.text} onChange={(event) => updateSegment(segment.id, event.target.value)} disabled={busy} aria-label={`第 ${index + 1} 句逐字稿`} /></div>) : <p className="empty">尚未取得逐字稿。</p>}</div></div>
        <p className="status" role="status">{status}</p>
      </section>

      <section className="panel">
        <div className="section-heading"><span className="step">2</span><div><h2>逐字稿修正補充資料 (修正專有名詞、人名的錯誤，可跳過)</h2><p>加入已確認詞彙或參考檔案，協助模型修正專有名詞與姓名。</p></div></div>
        <div className="supplement-block"><h3>確認詞彙</h3><div className="glossary-form"><textarea className="glossary-input" rows={2} placeholder="輸入姓名或專有名詞，以逗號或換行分隔，例如：王小明、MeetingTutor、CGU" value={newTermText} onChange={(e) => setNewTermText(e.target.value)} /><button className="secondary" onClick={addTerm}>加入詞彙</button></div>{glossary.length > 0 && <div className="chips">{glossary.map((term) => <button key={`${term.canonical}-${term.kind}`} className="chip" onClick={() => setGlossary((current) => current.filter((item) => item !== term))}>{term.kind}：{term.canonical} ×</button>)}</div>}{glossaryStatus && <p className="glossary-status" role="status">{glossaryStatus}</p>}{glossarySuggestions.length > 0 && <div className="glossary-suggestions"><strong>AI 詞彙建議（紅色文字為修飾結果，可直接編輯）</strong>{glossarySuggestions.map((suggestion) => <div className="glossary-suggestion" key={suggestion.id}><div className="glossary-suggestion-copy"><span>原詞：{suggestion.original}</span><label>修飾後：<input className="glossary-suggestion-input" value={suggestion.suggested} onChange={(event) => updateGlossarySuggestion(suggestion.id, event.target.value)} /></label>{suggestion.reason && <small>{suggestion.reason}</small>}</div><div className="glossary-suggestion-actions"><button className="secondary" type="button" onClick={() => restoreGlossarySuggestion(suggestion.id)}>還原</button><button className="primary" type="button" onClick={() => acceptGlossarySuggestion(suggestion)}>加入詞彙</button></div></div>)}</div>}</div>
        <div className="supplement-block"><h3>參考檔案</h3><label className="file-picker wide"><span>加入 PDF、TXT 或 Markdown</span><input type="file" accept="application/pdf,text/plain,text/markdown,.md,.txt" multiple onChange={addReferences} disabled={busy} /></label>{references.length > 0 && <ul className="reference-list">{references.map((reference) => <li key={reference.id}><span>{reference.name}</span><small>{reference.type === 'pdf' ? `${reference.pages} 頁` : `${reference.text.length.toLocaleString()} 字`}</small><button onClick={() => setReferences((current) => current.filter((item) => item.id !== reference.id))}>移除</button></li>)}</ul>}</div>
        <div className="glossary-ai-action"><button className="secondary" type="button" onClick={refineGlossary} disabled={busy}>AI 修飾、校正詞彙</button></div>
      </section>

      <section className="panel output-panel">
        <div className="section-heading"><span className="step">3</span><div><h2>產生摘要</h2><p>選擇適合的記錄模板與整理方向，再使用頁首保存的 AI 模型產生可直接使用的純文字記錄。</p></div></div>
        <div className="record-template"><strong>記錄模板</strong><button className="template-info-button" type="button" onClick={() => setTemplateHelpOpen((current) => !current)} aria-expanded={templateHelpOpen} aria-label="查看模板內容">i</button>{RECORD_TEMPLATE_OPTIONS.map((template) => <label key={template.id}><input type="radio" name="record-template" value={template.id} checked={recordTemplate === template.id} onChange={() => changeRecordTemplate(template.id)} disabled={busy} />{template.label}</label>)}</div>
        {templateHelpOpen && <div className="template-help" role="note"><strong>模板內容</strong><ul>{RECORD_TEMPLATE_OPTIONS.map((template) => <li key={template.id}><b>{template.label}</b>：{template.headings}</li>)}</ul></div>}
        <div className="system-prompt-panel">
          <label className="field"><span>AI 修正方向（System Prompt）</span><textarea value={systemPrompt} onChange={(event) => setSystemPrompt(event.target.value)} rows={5} maxLength={6000} disabled={busy} placeholder="例如：保留講者原意，將口語改為正式繁體中文；專有名詞不要自行猜測；摘要優先列出決議、負責人與期限。" /></label>
          <div className="system-prompt-examples"><span>快速範例（可複選，點擊後追加）</span><div>{SYSTEM_PROMPT_EXAMPLES.map((example) => <button type="button" key={example.label} onClick={() => addSystemPromptExample(example)} disabled={busy || systemPrompt.includes(example.prompt)} title={example.prompt}>{example.label}</button>)}</div></div>
          <div className="system-prompt-meta"><span>自動保存在此瀏覽器，重新整理後仍會保留。{systemPrompt.length.toLocaleString()} / 6,000 字</span><button type="button" className="secondary" onClick={() => setSystemPrompt('')} disabled={busy || !systemPrompt}>清除指示</button></div>
        </div>
        {recordTemplate === 'meeting' && <div className="output-options"><strong>選擇額外輸出</strong><span>待辦事項與下次議程會由 AI 根據會議記錄內容整理成純文字；找不到內容時不顯示。</span><label><input type="checkbox" checked={includeActions} onChange={(event) => setIncludeActions(event.target.checked)} disabled={busy} />輸出待辦事項</label><label><input type="checkbox" checked={includeAgenda} onChange={(event) => setIncludeAgenda(event.target.checked)} disabled={busy} />輸出下次議程</label></div>}
        <div className="action-row-centered"><button className="primary" onClick={generate} disabled={busy}>{generationStatus?.kind === 'working' ? '整理中…' : recordTemplateLabel(recordTemplate)}</button></div>
        {generationStatus && <p className={`generation-status is-${generationStatus.kind}`} role={generationStatus.kind === 'error' ? 'alert' : 'status'}>{generationStatus.message}</p>}
        {output && <div className="output-ready" role="status" ref={outputResultRef}>
          <div className="output-ready-heading"><strong>整理完成</strong><span>結果已直接顯示於下方。</span></div>
          <div className="output-results"><section className="output-result"><h3>{recordTemplateLabel(generatedTemplate)}</h3><pre>{output.minutes}</pre></section>{output.actions && <section className="output-result"><h3>本次待辦事項</h3><pre>{output.actions}</pre></section>}{output.agenda && <section className="output-result"><h3>下次會議議程</h3><pre>{output.agenda}</pre></section>}{polishedSegments.length > 0 && <section className="output-result polished-transcript-result"><div className="polished-transcript-heading"><div><h3>文字潤飾後逐字稿</h3><p>保留原始時間標記，可直接下載為 YouTube 字幕 SRT 檔。</p></div><button className="secondary" type="button" onClick={downloadPolishedTranscript}>下載 YouTube 字幕（SRT）</button></div><div className="polished-transcript-list">{polishedSegments.map((segment, index) => { const nextStart = polishedSegments[index + 1]?.start; const end = segment.end > segment.start ? segment.end : (typeof nextStart === 'number' && nextStart > segment.start ? nextStart : segment.start + 2); return <div className="polished-transcript-row" key={segment.id}><span className="polished-transcript-time">{formatSrtTime(segment.start)} → {formatSrtTime(end)}</span><span>{segment.text}</span></div> })}</div></section>}</div>
        </div>}
      </section>
    </main>
  </div>
}
