import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import './styles.css'
import type { GenerationResult, GlossaryTerm, Language, MeetingOutput, ModelInfo, ProviderConfig, ProviderId, ReasoningEffort, ReferenceDocument, TranscriptSegment } from './types'
import { PROVIDERS, generateText, listModels, providerLabel } from './lib/providers'
import { readReference } from './lib/references'
import { createPrompt, renderA4Html } from './lib/outputs'
import { transcribe } from './lib/transcription'
import { parseTeamsTranscript } from './lib/transcript'

const defaultProvider: ProviderId = 'openai'
const initialConfig: ProviderConfig = { id: defaultProvider, apiKey: '', baseUrl: PROVIDERS[0].defaultBaseUrl }
const API_KEYS_STORAGE_KEY = 'meetingtutor.api-keys.v1'
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

function download(name: string, content: string, type = 'text/plain;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  URL.revokeObjectURL(url)
}

function formatSeconds(seconds: number) {
  if (seconds < 0) return '--:--'
  const minutes = Math.floor(seconds / 60).toString().padStart(2, '0')
  const rest = Math.floor(seconds % 60).toString().padStart(2, '0')
  return `${minutes}:${rest}`
}

type CorrectionDecision = 'keep' | 'accept' | 'custom'
type ModelOutputBase = { notice: string; minutes: string; actions: string; agenda: string; source: string }
type ModelTestStatus = 'idle' | 'testing' | 'available' | 'empty' | 'error'
type GenerationStatus = { kind: 'working' | 'success' | 'error'; message: string }
type OutputPreviewTarget = 'notice' | 'minutes' | 'actions' | 'agenda' | 'a4Html'
const OUTPUT_ITEMS: Array<{ key: OutputPreviewTarget; label: string; filename: string; mime: string }> = [
  { key: 'notice', label: '通知信', filename: '01_會後通知信.md', mime: 'text/markdown;charset=utf-8' },
  { key: 'minutes', label: '完整會議紀錄', filename: '02_完整會議紀錄.md', mime: 'text/markdown;charset=utf-8' },
  { key: 'actions', label: '本次待辦事項', filename: '03_本次待辦事項.md', mime: 'text/markdown;charset=utf-8' },
  { key: 'agenda', label: '下次會議議程', filename: '04_下次會議議程.md', mime: 'text/markdown;charset=utf-8' },
  { key: 'a4Html', label: 'A4 HTML', filename: '05_會議成果彙整_A4列印.html', mime: 'text/html;charset=utf-8' },
]
const SYSTEM_PROMPT_EXAMPLES = [
  { label: '正式會議紀錄', prompt: '請將口語內容整理為正式、精簡的繁體中文，保留原意與各方立場，不新增逐字稿未提及的事實。' },
  { label: '決議與待辦優先', prompt: '請優先整理會議決議、待辦事項、負責人、期限與未決問題；逐字稿沒有明確資訊時請標示「待確認」，不要自行推測。' },
  { label: '專有名詞保守修正', prompt: '請依照已確認詞彙與參考資料修正人名、組織名及專有名詞；缺乏依據時保留原文並列入待確認事項。' },
  { label: '保留講者語氣', prompt: '請修正文法、贅詞與重複語句，但保留講者原本的語氣、觀點與不同意見，不要過度改寫。' },
]

function applyCorrectionChoices(result: GenerationResult, decisions: Record<number, CorrectionDecision>, customValues: Record<number, string>) {
  return result.changes.reduce((text, change, index) => {
    const decision = decisions[index] ?? 'accept'
    const replacement = decision === 'keep' ? change.from : decision === 'custom' ? (customValues[index] || change.to) : change.to
    return change.to ? text.replace(change.to, replacement) : text
  }, result.revisedText)
}

export default function App() {
  const [language, setLanguage] = useState<Language>('zh')
  const [whisperModel, setWhisperModel] = useState<'tiny' | 'base'>('base')
  const [audioFile, setAudioFile] = useState<File | null>(null)
  const [transcriptFile, setTranscriptFile] = useState<File | null>(null)
  const [uploadedTranscriptSegments, setUploadedTranscriptSegments] = useState<TranscriptSegment[]>([])
  const [recording, setRecording] = useState(false)
  const [mediaRecorder, setMediaRecorder] = useState<MediaRecorder | null>(null)
  const [segments, setSegments] = useState<TranscriptSegment[]>([])
  const [references, setReferences] = useState<ReferenceDocument[]>([])
  const [glossary, setGlossary] = useState<GlossaryTerm[]>([])
  const [newTermText, setNewTermText] = useState('')
  const [config, setConfig] = useState<ProviderConfig>(() => ({ ...initialConfig, apiKey: storedApiKey(defaultProvider) }))
  const [models, setModels] = useState<ModelInfo[]>([])
  const [modelTestStatus, setModelTestStatus] = useState<ModelTestStatus>('idle')
  const [systemPrompt, setSystemPrompt] = useState(storedSystemPrompt)
  const [status, setStatus] = useState('請選擇音訊檔或開始錄音。')
  const [busy, setBusy] = useState(false)
  const [output, setOutput] = useState<MeetingOutput | null>(null)
  const [outputPreviewTarget, setOutputPreviewTarget] = useState<OutputPreviewTarget | null>(null)
  const [generationStatus, setGenerationStatus] = useState<GenerationStatus | null>(null)
  const [modelOutputBase, setModelOutputBase] = useState<ModelOutputBase | null>(null)
  const [correctionResult, setCorrectionResult] = useState<GenerationResult | null>(null)
  const [correctionDecisions, setCorrectionDecisions] = useState<Record<number, CorrectionDecision>>({})
  const [customCorrections, setCustomCorrections] = useState<Record<number, string>>({})
  const [hardwareResult, setHardwareResult] = useState<string | null>(null)
  const [showKey, setShowKey] = useState(false)
  const liveTranscriptRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    try {
      const keys = storedApiKeys()
      keys[config.id] = config.apiKey
      window.localStorage.setItem(API_KEYS_STORAGE_KEY, JSON.stringify(keys))
    } catch { /* Private browsing or blocked storage: keep the key in memory only. */ }
  }, [config.id, config.apiKey])

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

  const transcriptText = useMemo(() => segments.map((segment) => segment.text).join(' '), [segments])
  const approvedCorrectionText = useMemo(() => correctionResult ? applyCorrectionChoices(correctionResult, correctionDecisions, customCorrections) : '', [correctionResult, correctionDecisions, customCorrections])

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
    if (file) {
      setTranscriptFile(null)
      setUploadedTranscriptSegments([])
    }
    setStatus(file ? `已選擇：${file.name}` : '請選擇音訊檔或開始錄音。')
  }

  const onTranscriptChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null
    setTranscriptFile(file)
    setUploadedTranscriptSegments([])
    setSegments([])
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
      setStatus(`已加入 ${parsed.length} 份參考資料。掃描型 PDF 若沒有文字層，需先 OCR。`)
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
      setModels(result)
      setConfig((current) => ({ ...current, modelId: result[0]?.id }))
      setModelTestStatus(result.length ? 'available' : 'empty')
      setStatus(result.length ? `模型可用：已讀取 ${result.length} 個模型。${config.id === 'cgu' && /luna/i.test(`${result[0].id} ${result[0].displayName}`) ? `預設選擇最新 Luna：${result[0].displayName}` : ''}` : '測試成功，但 provider 沒有回傳可列舉的模型。')
    } catch (error) {
      setModels([])
      setModelTestStatus('error')
      setStatus(`Provider 測試失敗：${error instanceof Error ? error.message : String(error)}；請檢查 Key、Base URL、CORS 或服務狀態。`)
    } finally { setBusy(false) }
  }

  const clearApiKeys = () => {
    try { window.localStorage.removeItem(API_KEYS_STORAGE_KEY) } catch { /* Keep going if storage is unavailable. */ }
    setConfig((current) => ({ ...current, apiKey: '', modelId: undefined }))
    setModels([])
    setModelTestStatus('idle')
    setStatus('已清除瀏覽器中保存的 API Key。')
  }

  const addTerm = () => {
    const terms = newTermText.split(/[\n,，、;；]+/).map((term) => term.trim()).filter(Boolean)
    if (!terms.length) return
    setGlossary((current) => [...current, ...terms.filter((term) => !current.some((item) => item.canonical === term)).map((canonical) => ({ canonical, aliases: '', kind: '其他' as const, locked: true }))])
    setNewTermText('')
  }

  const addSystemPromptExample = (example: string) => {
    setSystemPrompt((current) => {
      const existing = current.trim()
      if (existing.includes(example)) return current
      return `${existing ? `${existing}\n\n` : ''}${example}`.slice(0, 6000)
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
      const message = '請先在第四步測試 API Key 並選擇模型。'
      setGenerationStatus({ kind: 'error', message })
      setStatus(message)
      return
    }
    setBusy(true)
    setOutputPreviewTarget(null)
    setGenerationStatus({ kind: 'working', message: `正在使用 ${config.modelId} 整理會議紀錄，請稍候…` })
    try {
      const prompt = createPrompt(segments, references, glossary, language)
      const result = await generateText(config, prompt, systemPrompt)
      const revised = result.revisedText || transcriptText
      const notice = `主旨：【會後通知】會議名稱待確認｜日期待確認\n\n各位好：\n\n以下為模型整理草稿，請逐項核對原始逐字稿。\n\n一、語句修飾後內容\n${revised}\n\n二、專有名詞／姓名\n${result.terms.map((term) => `- ${term.source} → ${term.suggested}（${term.status}）`).join('\n') || '- 未偵測到可確認詞彙'}\n\n三、待確認事項\n${result.uncertainties.map((item) => `- ${item}`).join('\n') || '- 無'}\n\n本信為草稿，未寄出。`
      const minutes = `# 會議名稱待確認｜會議紀錄\n\n- 會議日期／時間：待確認\n- 地點：未提供\n- 資料來源：瀏覽器端逐字稿與使用者參考資料\n\n## 一、修正後逐字稿\n${revised}\n\n## 二、修訂與來源\n${result.changes.map((change) => `- ${change.from} → ${change.to}：${change.reason}（${change.confidence}）`).join('\n') || '- 模型未提供差異'}\n\n## 三、決策與理由\n- DEC-DATE-UNKNOWN-01：狀態：未決；請人工確認，不得將模型推測視為正式決議。\n\n## 四、待確認事項\n${result.uncertainties.map((item) => `- ${item}`).join('\n') || '- 無'}`
      const actions = `# 待辦追蹤表\n\n| 任務編號 | 待辦事項 | 主責人 | 協作人 | 完成標準 | 期限 | 狀態 | 關聯決策 | 來源會議 | 備註／阻礙 |\n|---|---|---|---|---|---|---|---|---|---|\n| ACT-DATE-UNKNOWN-01 | 人工核對模型修訂與待確認事項 | 待指定 | 無 | 完成核准的會議紀錄 | 待確認 | 待驗收 | DEC-DATE-UNKNOWN-01 | 會議名稱待確認 | 來源：模型輸出與逐字稿 |`
      const agenda = `# 下次會議議程（草稿）\n\n- 預定日期：待安排\n- 會議目標：確認模型提出的修訂、專有名詞與未決事項。\n\n| 優先序 | 議題 | 事前準備／負責人 | 預期產出 | 關聯編號 |\n|---|---|---|---|---|\n| 1 | 檢閱未決與術語 | 會議紀錄者；提供原始資料 | 核准或修正決議 | DEC-DATE-UNKNOWN-01／ACT-DATE-UNKNOWN-01 |`
      const source = references.map((reference) => reference.name).join('、') || '未提供'
      setModelOutputBase({ notice, minutes, actions, agenda, source })
      setCorrectionResult(result)
      setCorrectionDecisions(Object.fromEntries(result.changes.map((_, index) => [index, 'accept' as const])))
      setCustomCorrections({})
      setOutput({ notice, minutes, actions, agenda, a4Html: renderA4Html(notice, minutes, actions, agenda, source) })
      const message = '整理完成，可直接預覽或下載會議成果。'
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
    } finally { setBusy(false) }
  }

  const applyCorrectionsToOutput = () => {
    if (!output || !modelOutputBase || !correctionResult) return
    const replaceRevision = (text: string) => text.replace(correctionResult.revisedText, approvedCorrectionText)
    const notice = replaceRevision(modelOutputBase.notice)
    const minutes = replaceRevision(modelOutputBase.minutes)
    setOutput({ ...output, notice, minutes, a4Html: renderA4Html(notice, minutes, modelOutputBase.actions, modelOutputBase.agenda, modelOutputBase.source) })
    setStatus('已將文字校正選擇套用到匯出草稿。')
  }

  return <div className="app-shell">
    <header className="hero">
      <div><p className="eyebrow">MeetingTutor</p><h1>會議記錄轉錄器</h1><div className="hardware-row"><p className="hardware-note">最低硬體建議：四核心現代處理器、8 GB RAM、至少 2 GB 可用空間；使用最新版 Chrome／Edge／Firefox，WebGPU 可用時速度較佳。</p><button className="hardware-button" onClick={checkHardware}>檢測我的硬體</button></div>{hardwareResult && <p className="hardware-result" role="status">{hardwareResult}</p>}</div>
      <div className="privacy-badge">🔒 音訊預設只在本機處理<br /><small>API Key 不會寫入專案</small></div>
    </header>

    <main className="workspace">
      <section className="panel"><div className="section-heading"><span className="step">1</span><div><h2>取得音訊</h2><p>轉寫語言預設為中文，也可選擇英文。</p></div></div>
        <div className="controls-row"><label className="field"><span>轉寫語言</span><select value={language} onChange={(event) => setLanguage(event.target.value as Language)} disabled={busy}><option value="zh">中文（繁體／多語模型）</option><option value="en">English（英文模型）</option></select></label><label className="field"><span>Whisper 模型</span><select value={whisperModel} onChange={(event) => setWhisperModel(event.target.value as 'tiny' | 'base')} disabled={busy}><option value="base">Whisper-base（預設，較準確）</option><option value="tiny">Whisper-tiny（較快、較省資源）</option></select></label><label className="file-picker"><span>選擇音訊</span><input type="file" accept="audio/*,video/*" onChange={onAudioChange} disabled={busy} /></label><button className="secondary" onClick={recording ? stopRecording : startRecording} disabled={busy}>{recording ? '停止錄音' : '開始錄音'}</button></div>
        <div className="controls-row transcript-upload-row"><label className="file-picker wide"><span>或上傳 Teams 逐字稿（.vtt／.txt／.srt）</span><input type="file" accept=".vtt,.txt,.srt,text/vtt,text/plain" onChange={onTranscriptChange} disabled={busy} /></label></div>
        {audioFile && <p className="file-note">已準備：{audioFile.name}（{Math.round(audioFile.size / 1024)} KB）</p>}
        {transcriptFile && <p className="file-note">已準備 Teams 逐字稿：{transcriptFile.name}（{uploadedTranscriptSegments.length} 段）</p>}
        <p className="hint">Whisper 模型首次下載後會保存於此瀏覽器快取；之後相同模型可直接重用。</p>
        <button className="primary" onClick={runTranscription} disabled={busy || (!audioFile && !transcriptFile)}>{busy ? '處理中…' : transcriptFile && !audioFile ? '載入逐字稿' : '開始轉錄／載入逐字稿'}</button>
        <div className="live-transcript" aria-live="polite"><div className="live-transcript-heading"><strong>逐句轉錄結果</strong><span>{segments.length ? `目前 ${segments.length} 句` : '辨識時會逐句顯示在這裡'}</span></div><div className="live-transcript-box" ref={liveTranscriptRef}>{segments.length ? segments.map((segment) => <div className="live-segment" key={segment.id}><span className="timestamp">{formatSeconds(segment.start)}</span><span>{segment.text}</span></div>) : <p className="empty">尚未取得轉錄句子。</p>}</div></div>
        <p className="status" role="status">{status}</p>
      </section>

      <section className="panel">
        <div className="section-heading"><span className="step">3</span><div><h2>逐字稿修正補充資料 (修正專有名詞、人名的錯誤，可跳過)</h2><p>加入已確認詞彙或參考檔案，協助模型修正專有名詞與姓名。</p></div></div>
        <div className="supplement-block"><h3>確認詞彙</h3><div className="glossary-form"><textarea className="glossary-input" rows={2} placeholder="輸入姓名或專有名詞，以逗號或換行分隔，例如：王小明、MeetingTutor、CGU" value={newTermText} onChange={(e) => setNewTermText(e.target.value)} /><button className="secondary" onClick={addTerm}>加入詞彙</button></div>{glossary.length > 0 && <div className="chips">{glossary.map((term) => <button key={`${term.canonical}-${term.kind}`} className="chip" onClick={() => setGlossary((current) => current.filter((item) => item !== term))}>{term.kind}：{term.canonical} ×</button>)}</div>}</div>
        <div className="supplement-block"><h3>參考檔案</h3><label className="file-picker wide"><span>加入 PDF、TXT 或 Markdown</span><input type="file" accept="application/pdf,text/plain,text/markdown,.md,.txt" multiple onChange={addReferences} disabled={busy} /></label>{references.length > 0 && <ul className="reference-list">{references.map((reference) => <li key={reference.id}><span>{reference.name}</span><small>{reference.type === 'pdf' ? `${reference.pages} 頁` : `${reference.text.length.toLocaleString()} 字`}</small><button onClick={() => setReferences((current) => current.filter((item) => item.id !== reference.id))}>移除</button></li>)}</ul>}<p className="hint">掃描型 PDF 沒有文字層時，系統會提示需要 OCR，不會假裝讀取成功。</p></div>
      </section>

      <section className="panel"><div className="section-heading"><span className="step">4</span><div><h2>連接你的模型</h2><p>Key 只在目前工作階段使用；測試成功後才會顯示模型。</p></div></div>
        <div className="provider-grid"><label className="field"><span>Provider</span><select value={config.id} onChange={(e) => updateProvider(e.target.value as ProviderId)} disabled={busy}>{PROVIDERS.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}</select></label><label className="field"><span>API Key（保存在本機瀏覽器）</span><div className="key-input"><input type={showKey ? 'text' : 'password'} value={config.apiKey} onChange={(e) => updateApiKey(e.target.value)} autoComplete="off" placeholder="貼上你的 Key" disabled={busy} /><button type="button" onClick={() => setShowKey((value) => !value)}>{showKey ? '隱藏' : '顯示'}</button><button type="button" onClick={clearApiKeys} disabled={busy}>清除 API Key</button></div></label><label className="field"><span>API Base URL</span><input value={config.baseUrl ?? ''} onChange={(e) => updateBaseUrl(e.target.value)} disabled={busy} /></label>{config.id === 'cgu' && <label className="field"><span>CGU 推理程度（預設：中）</span><select value={config.reasoningEffort ?? 'medium'} onChange={(e) => setConfig((current) => ({ ...current, reasoningEffort: e.target.value as ReasoningEffort }))} disabled={busy}><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></label>}</div>
        <p className="hint">{PROVIDERS.find((provider) => provider.id === config.id)?.hint}</p><button className="secondary" onClick={testProvider} disabled={busy || !config.apiKey}>{busy ? '測試中…' : '測試 Key 並讀取模型'}</button>{modelTestStatus === 'available' && <p className="model-available" role="status">模型可用（已讀取 {models.length} 個）</p>}{modelTestStatus === 'empty' && <p className="model-unavailable" role="status">測試成功，但沒有可列舉的模型。</p>}{models.length > 0 && <label className="field model-select"><span>選擇模型</span><select value={config.modelId ?? ''} onChange={(e) => setConfig({ ...config, modelId: e.target.value })}>{models.map((model) => <option key={model.id} value={model.id}>{model.displayName}（{model.id}）</option>)}</select></label>}
        <div className="system-prompt-panel">
          <label className="field"><span>AI 修正方向（System Prompt）</span><textarea value={systemPrompt} onChange={(event) => setSystemPrompt(event.target.value)} rows={5} maxLength={6000} disabled={busy} placeholder="例如：保留講者原意，將口語改為正式繁體中文；專有名詞不要自行猜測；摘要優先列出決議、負責人與期限。" /></label>
          <div className="system-prompt-examples"><span>快速範例（可複選，點擊後追加）</span><div>{SYSTEM_PROMPT_EXAMPLES.map((example) => <button type="button" key={example.label} onClick={() => addSystemPromptExample(example.prompt)} disabled={busy || systemPrompt.includes(example.prompt)} title={example.prompt}>{example.label}</button>)}</div></div>
          <div className="system-prompt-meta"><span>自動保存在此瀏覽器，重新整理後仍會保留。{systemPrompt.length.toLocaleString()} / 6,000 字</span><button type="button" className="secondary" onClick={() => setSystemPrompt('')} disabled={busy || !systemPrompt}>清除指示</button></div>
        </div>
      </section>

      <section className="panel output-panel">
        <div className="section-heading"><span className="step">5</span><div><h2>產生會議成果</h2><p>使用第四步選定的模型整理；完成後可預覽或下載。</p></div></div>
        <div className="controls-row"><button className="primary" onClick={generate} disabled={busy}>{generationStatus?.kind === 'working' ? '整理中…' : '整理會議紀錄'}</button></div>
        {generationStatus && <p className={`generation-status is-${generationStatus.kind}`} role={generationStatus.kind === 'error' ? 'alert' : 'status'}>{generationStatus.message}</p>}
        {output && <div className="output-ready" role="status">
          <div className="output-ready-heading"><strong>整理完成</strong><span>可先預覽內容，再下載需要的文件。</span></div>
          <div className="output-files">{OUTPUT_ITEMS.map((item) => <div className="output-file" key={item.key}><strong>{item.label}</strong><div className="output-file-actions"><button className={outputPreviewTarget === item.key ? 'preview-button is-active' : 'preview-button'} onClick={() => setOutputPreviewTarget((current) => current === item.key ? null : item.key)}>{outputPreviewTarget === item.key ? '收起預覽' : '預覽'}</button><button onClick={() => download(item.filename, output[item.key], item.mime)}>下載</button></div></div>)}</div>
          {outputPreviewTarget && <div className="output-single-preview"><div className="output-preview-heading"><h3>{OUTPUT_ITEMS.find((item) => item.key === outputPreviewTarget)?.label}預覽</h3><button type="button" onClick={() => setOutputPreviewTarget(null)}>關閉</button></div>{outputPreviewTarget === 'a4Html' ? <iframe className="a4-preview-frame" title="A4 HTML 預覽" srcDoc={output.a4Html} sandbox="allow-modals allow-scripts" /> : <pre>{output[outputPreviewTarget]}</pre>}</div>}
        </div>}
        {correctionResult && <div className="correction-review"><h3>文字校正確認</h3><p className="hint">紅色文字是模型建議的編修詞。預設為「同意編修」；請逐項選擇後再套用到匯出草稿。</p>{correctionResult.changes.length ? <div className="correction-list">{correctionResult.changes.map((change, index) => <div className="correction-item" key={`${change.from}-${change.to}-${index}`}><div className="correction-text"><span>原文：{change.from}</span><span>建議：<mark className="correction-red">{change.to}</mark></span><small>{change.reason}（信心：{change.confidence}）</small></div><select value={correctionDecisions[index] ?? 'accept'} onChange={(event) => setCorrectionDecisions((current) => ({ ...current, [index]: event.target.value as CorrectionDecision }))}><option value="keep">維持原文</option><option value="accept">同意編修</option><option value="custom">自己輸入</option></select>{correctionDecisions[index] === 'custom' && <input className="custom-correction" value={customCorrections[index] ?? ''} placeholder="輸入要使用的文字" onChange={(event) => setCustomCorrections((current) => ({ ...current, [index]: event.target.value }))} />}</div>)}</div> : <p className="empty">模型沒有回傳可辨識的編修詞。</p>}<div className="approved-preview"><strong>核准後文字預覽</strong><p>{approvedCorrectionText || correctionResult.revisedText}</p></div><button className="secondary" onClick={applyCorrectionsToOutput} disabled={!output || !correctionResult}>套用文字校正到匯出草稿</button></div>}
      </section>
    </main>
  </div>
}
