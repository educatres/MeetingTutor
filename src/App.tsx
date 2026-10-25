import { useMemo, useState } from 'react'
import type { ChangeEvent } from 'react'
import './styles.css'
import type { GlossaryTerm, Language, MeetingOutput, ModelInfo, ProviderConfig, ProviderId, ReferenceDocument, TranscriptSegment } from './types'
import { PROVIDERS, generateText, listModels, providerLabel } from './lib/providers'
import { readReference, relevantReferenceText } from './lib/references'
import { createPrompt, localOutputs, renderA4Html } from './lib/outputs'
import { transcribe } from './lib/transcription'

const defaultProvider: ProviderId = 'openai'
const initialConfig: ProviderConfig = { id: defaultProvider, apiKey: '', baseUrl: PROVIDERS[0].defaultBaseUrl }

function download(name: string, content: string, type = 'text/plain;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  URL.revokeObjectURL(url)
}

function formatSeconds(seconds: number) {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, '0')
  const rest = Math.floor(seconds % 60).toString().padStart(2, '0')
  return `${minutes}:${rest}`
}

export default function App() {
  const [language, setLanguage] = useState<Language>('zh')
  const [audioFile, setAudioFile] = useState<File | null>(null)
  const [recording, setRecording] = useState(false)
  const [mediaRecorder, setMediaRecorder] = useState<MediaRecorder | null>(null)
  const [segments, setSegments] = useState<TranscriptSegment[]>([])
  const [references, setReferences] = useState<ReferenceDocument[]>([])
  const [glossary, setGlossary] = useState<GlossaryTerm[]>([])
  const [newTerm, setNewTerm] = useState<GlossaryTerm>({ canonical: '', aliases: '', kind: '其他', locked: true })
  const [config, setConfig] = useState<ProviderConfig>(initialConfig)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [status, setStatus] = useState('請選擇音訊檔或開始錄音。')
  const [busy, setBusy] = useState(false)
  const [output, setOutput] = useState<MeetingOutput | null>(null)
  const [showKey, setShowKey] = useState(false)

  const transcriptText = useMemo(() => segments.map((segment) => segment.text).join(' '), [segments])

  const updateProvider = (id: ProviderId) => {
    const provider = PROVIDERS.find((item) => item.id === id)!
    setConfig({ id, apiKey: '', baseUrl: provider.defaultBaseUrl, modelId: undefined })
    setModels([])
  }

  const onAudioChange = (event: ChangeEvent<HTMLInputElement>) => {
    setAudioFile(event.target.files?.[0] ?? null)
    setStatus(event.target.files?.[0] ? `已選擇：${event.target.files[0].name}` : '請選擇音訊檔或開始錄音。')
  }

  const startRecording = async () => {
    try {
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
    if (!audioFile) return setStatus('請先選擇音訊檔或完成錄音。')
    setBusy(true)
    try {
      const result = await transcribe(audioFile, language, (progress) => {
        const percent = typeof progress.progress === 'number' ? ` ${Math.round(progress.progress)}%` : ''
        setStatus(`${progress.status ?? '處理中…'}${percent}`)
      })
      setSegments(result)
      setStatus(`完成轉錄，共 ${result.length} 個段落。`)
    } catch (error) {
      setStatus(`轉錄失敗：${error instanceof Error ? error.message : String(error)}`)
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
    setStatus(`正在測試 ${providerLabel(config.id)} 並讀取模型…`)
    try {
      const result = await listModels(config)
      setModels(result)
      setConfig((current) => ({ ...current, modelId: result[0]?.id }))
      setStatus(result.length ? `測試成功，可用模型 ${result.length} 個。` : '測試成功，但 provider 沒有回傳可列舉的模型。')
    } catch (error) {
      setModels([])
      setStatus(`Provider 測試失敗：${error instanceof Error ? error.message : String(error)}（Key 未被保存）`)
    } finally { setBusy(false) }
  }

  const addTerm = () => {
    if (!newTerm.canonical.trim()) return
    setGlossary((current) => [...current, { ...newTerm, canonical: newTerm.canonical.trim() }])
    setNewTerm({ canonical: '', aliases: '', kind: '其他', locked: true })
  }

  const updateSegment = (id: string, text: string) => setSegments((current) => current.map((segment) => segment.id === id ? { ...segment, text } : segment))

  const generate = async (useModel: boolean) => {
    if (!segments.length) return setStatus('請先完成轉錄。')
    setBusy(true)
    try {
      if (useModel) {
        const prompt = createPrompt(segments, references, glossary)
        const result = await generateText(config, prompt)
        const revised = result.revisedText || transcriptText
        const notice = `主旨：【會後通知】會議名稱待確認｜日期待確認\n\n各位好：\n\n以下為模型整理草稿，請逐項核對原始逐字稿。\n\n一、語句修飾後內容\n${revised}\n\n二、專有名詞／姓名\n${result.terms.map((term) => `- ${term.source} → ${term.suggested}（${term.status}）`).join('\n') || '- 未偵測到可確認詞彙'}\n\n三、待確認事項\n${result.uncertainties.map((item) => `- ${item}`).join('\n') || '- 無'}\n\n本信為草稿，未寄出。`
        const minutes = `# 會議名稱待確認｜會議紀錄\n\n- 會議日期／時間：待確認\n- 地點：未提供\n- 資料來源：瀏覽器端逐字稿與使用者參考資料\n\n## 一、會議摘要\n${revised}\n\n## 二、修訂與來源\n${result.changes.map((change) => `- ${change.from} → ${change.to}：${change.reason}（${change.confidence}）`).join('\n') || '- 模型未提供差異'}\n\n## 三、決策與理由\n- DEC-DATE-UNKNOWN-01：狀態：未決；請人工確認，不得將模型推測視為正式決議。\n\n## 四、待確認事項\n${result.uncertainties.map((item) => `- ${item}`).join('\n') || '- 無'}\n\n## 五、原始逐字稿\n${transcriptText}`
        const actions = `# 待辦追蹤表\n\n| 任務編號 | 待辦事項 | 主責人 | 協作人 | 完成標準 | 期限 | 狀態 | 關聯決策 | 來源會議 | 備註／阻礙 |\n|---|---|---|---|---|---|---|---|---|---|\n| ACT-DATE-UNKNOWN-01 | 人工核對模型修訂與待確認事項 | 待指定 | 無 | 完成核准的會議紀錄 | 待確認 | 待驗收 | DEC-DATE-UNKNOWN-01 | 會議名稱待確認 | 來源：模型輸出與逐字稿 |`
        const agenda = `# 下次會議議程（草稿）\n\n- 預定日期：待安排\n- 會議目標：確認模型提出的修訂、專有名詞與未決事項。\n\n| 優先序 | 議題 | 事前準備／負責人 | 預期產出 | 關聯編號 |\n|---|---|---|---|---|\n| 1 | 檢閱未決與術語 | 會議紀錄者；提供原始資料 | 核准或修正決議 | DEC-DATE-UNKNOWN-01／ACT-DATE-UNKNOWN-01 |`
        setOutput({ notice, minutes, actions, agenda, a4Html: renderA4Html(notice, minutes, actions, agenda, references.map((reference) => reference.name).join('、') || '未提供') })
        setStatus('模型草稿已產生，請檢閱差異與待確認事項。')
      } else {
        setOutput(localOutputs(segments, references, glossary))
        setStatus('已產生本地結構草稿；尚未使用外部模型。')
      }
    } catch (error) {
      setStatus(`生成失敗：${error instanceof Error ? error.message : String(error)}`)
    } finally { setBusy(false) }
  }

  return <div className="app-shell">
    <header className="hero">
      <div><p className="eyebrow">MEETINGTUTOR · LOCAL-FIRST</p><h1>會議記錄轉錄器</h1><p>在瀏覽器中轉錄，再用你自己的模型修飾語句與整理會議文件。</p></div>
      <div className="privacy-badge">🔒 音訊預設只在本機處理<br /><small>API Key 不會寫入專案</small></div>
    </header>

    <main className="workspace">
      <section className="panel"><div className="section-heading"><span className="step">1</span><div><h2>取得音訊</h2><p>轉寫語言預設為中文，也可選擇英文。</p></div></div>
        <div className="controls-row"><label className="field"><span>轉寫語言</span><select value={language} onChange={(event) => setLanguage(event.target.value as Language)} disabled={busy}><option value="zh">中文（繁體／多語模型）</option><option value="en">English（英文模型）</option></select></label><label className="file-picker"><span>選擇音訊</span><input type="file" accept="audio/*,video/*" onChange={onAudioChange} disabled={busy} /></label><button className="secondary" onClick={recording ? stopRecording : startRecording} disabled={busy}>{recording ? '停止錄音' : '開始錄音'}</button></div>
        {audioFile && <p className="file-note">已準備：{audioFile.name}（{Math.round(audioFile.size / 1024)} KB）</p>}
        <button className="primary" onClick={runTranscription} disabled={busy || !audioFile}>{busy ? '處理中…' : '開始轉錄'}</button>
        <p className="status" role="status">{status}</p>
      </section>

      <section className="panel"><div className="section-heading"><span className="step">2</span><div><h2>逐字稿與詞彙</h2><p>原文保留；人名／專有名詞請先加入已確認詞彙。</p></div></div>
        <div className="glossary-form"><input placeholder="正確寫法，例如：MeetingTutor" value={newTerm.canonical} onChange={(e) => setNewTerm({ ...newTerm, canonical: e.target.value })} /><input placeholder="別名（可選）" value={newTerm.aliases} onChange={(e) => setNewTerm({ ...newTerm, aliases: e.target.value })} /><select value={newTerm.kind} onChange={(e) => setNewTerm({ ...newTerm, kind: e.target.value as GlossaryTerm['kind'] })}><option>姓名</option><option>專案</option><option>產品</option><option>其他</option></select><button className="secondary" onClick={addTerm}>加入詞彙</button></div>
        {glossary.length > 0 && <div className="chips">{glossary.map((term) => <button key={`${term.canonical}-${term.kind}`} className="chip" onClick={() => setGlossary((current) => current.filter((item) => item !== term))}>{term.kind}：{term.canonical} ×</button>)}</div>}
        <div className="transcript-box">{segments.length ? segments.map((segment) => <div className="segment" key={segment.id}><span className="timestamp">{formatSeconds(segment.start)}</span><textarea value={segment.text} onChange={(e) => updateSegment(segment.id, e.target.value)} aria-label={`逐字稿 ${formatSeconds(segment.start)}`} /></div>) : <p className="empty">完成轉錄後，逐字稿會出現在這裡。</p>}</div>
      </section>

      <section className="panel"><div className="section-heading"><span className="step">3</span><div><h2>參考資料</h2><p>加入 PDF、TXT 或 Markdown，協助校正專有名詞與姓名。</p></div></div><label className="file-picker wide"><span>加入參考檔案</span><input type="file" accept="application/pdf,text/plain,text/markdown,.md,.txt" multiple onChange={addReferences} disabled={busy} /></label>{references.length > 0 && <ul className="reference-list">{references.map((reference) => <li key={reference.id}><span>{reference.name}</span><small>{reference.type === 'pdf' ? `${reference.pages} 頁` : `${reference.text.length.toLocaleString()} 字`}</small><button onClick={() => setReferences((current) => current.filter((item) => item.id !== reference.id))}>移除</button></li>)}</ul>}<p className="hint">掃描型 PDF 沒有文字層時，系統會提示需要 OCR，不會假裝讀取成功。</p></section>

      <section className="panel"><div className="section-heading"><span className="step">4</span><div><h2>連接你的模型</h2><p>Key 只在目前工作階段使用；測試成功後才會顯示模型。</p></div></div>
        <div className="provider-grid"><label className="field"><span>Provider</span><select value={config.id} onChange={(e) => updateProvider(e.target.value as ProviderId)} disabled={busy}>{PROVIDERS.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}</select></label><label className="field"><span>API Key（不會保存）</span><div className="key-input"><input type={showKey ? 'text' : 'password'} value={config.apiKey} onChange={(e) => setConfig({ ...config, apiKey: e.target.value })} autoComplete="off" placeholder="貼上你的 Key" disabled={busy} /><button type="button" onClick={() => setShowKey((value) => !value)}>{showKey ? '隱藏' : '顯示'}</button></div></label><label className="field"><span>{config.id === 'cgu' ? 'CGU API endpoint（需正式契約）' : 'API Base URL'}</span><input value={config.baseUrl ?? ''} onChange={(e) => setConfig({ ...config, baseUrl: e.target.value })} placeholder={config.id === 'cgu' ? '尚待確認，例如 https://…/v1' : undefined} disabled={busy} /></label></div>
        <p className="hint">{PROVIDERS.find((provider) => provider.id === config.id)?.hint}</p><button className="secondary" onClick={testProvider} disabled={busy || !config.apiKey}>{busy ? '測試中…' : '測試 Key 並讀取模型'}</button>{models.length > 0 && <label className="field model-select"><span>選擇模型</span><select value={config.modelId ?? ''} onChange={(e) => setConfig({ ...config, modelId: e.target.value })}>{models.map((model) => <option key={model.id} value={model.id}>{model.displayName}（{model.id}）</option>)}</select></label>}
      </section>

      <section className="panel output-panel"><div className="section-heading"><span className="step">5</span><div><h2>產生會議成果</h2><p>先產生草稿，再人工核對；產品不會自動寄信或建立行事曆。</p></div></div><div className="controls-row"><button className="primary" onClick={() => generate(true)} disabled={busy || !segments.length || !config.modelId}>使用選定模型整理</button><button className="secondary" onClick={() => generate(false)} disabled={busy || !segments.length}>只建立本地結構草稿</button></div>{output && <div className="output-actions"><button onClick={() => download('01_會後通知信.md', output.notice)}>下載通知信</button><button onClick={() => download('02_完整會議紀錄.md', output.minutes)}>下載完整紀錄</button><button onClick={() => download('03_本次待辦事項.md', output.actions)}>下載待辦</button><button onClick={() => download('04_下次會議議程.md', output.agenda)}>下載議程</button><button onClick={() => download('05_會議成果彙整_A4列印.html', output.a4Html, 'text/html;charset=utf-8')}>下載 A4 HTML</button></div>}{output && <details className="preview"><summary>預覽通知信草稿</summary><pre>{output.notice}</pre></details>}</section>
    </main>
    <footer>MeetingTutor MVP · 本頁不代管 API Key · 請依會議資料人工核准 AI 產出</footer>
  </div>
}
