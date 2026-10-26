import type { GlossarySuggestion, GlossaryTerm, Language, RecordTemplate, ReferenceDocument, TranscriptSegment } from '../types'

export const normalizeLineBreaks = (value: string) => value.replace(/\\r\\n|\\n|\\r/g, '\n').replace(/\r\n?/g, '\n')
const formatTime = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds <= 0) return '00:00'
  const minutes = Math.floor(seconds / 60).toString().padStart(2, '0')
  const secs = Math.floor(seconds % 60).toString().padStart(2, '0')
  return `${minutes}:${secs}`
}

function transcriptForPrompt(segments: TranscriptSegment[]) {
  return segments.map((segment) => `${formatTime(segment.start)} ${segment.speaker || '未指定說話者'}：${segment.text}`).join('\n').slice(0, 28_000)
}

function collectJsonText(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() ? [value] : []
  if (Array.isArray(value)) return value.flatMap(collectJsonText)
  if (value && typeof value === 'object') return Object.values(value).flatMap(collectJsonText)
  return []
}

export function cleanPlainTextOutput(value: string) {
  let text = normalizeLineBreaks(value).trim()
  text = text.replace(/^```(?:json|markdown|md|text|html)?\s*/i, '').replace(/\s*```$/i, '').trim()
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>
      const candidate = ['documentText', 'meetingMinutes', 'minutes', 'classNotes', 'summary', 'content', 'revisedText', 'text']
        .map((key) => parsed[key])
        .find((item): item is string => typeof item === 'string' && item.trim().length > 0)
      const extracted = candidate ? [candidate] : collectJsonText(parsed)
      if (extracted.length) text = normalizeLineBreaks(extracted.join('\n\n')).trim()
    } catch { /* Keep the original response and strip presentation markers below. */ }
  }
  const plain = text
    .replace(/^```(?:json|markdown|md|text|html)?\s*$/gim, '')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/^\s*[-*]\s+/gm, '• ')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return plain.split('\n')
    .filter((line) => !/^\s*\|?\s*:?-{3,}/.test(line))
    .map((line) => /^\s*\|.*\|\s*$/.test(line) ? line.split('|').map((cell) => cell.trim()).filter(Boolean).join('　') : line)
    .join('\n')
    .trim()
}

function sectionHeading(line: string) {
  return line
    .trim()
    .replace(/^#{1,6}\s*/, '')
    .replace(/^[一二三四五六七八九十百\d]+[、.．)）]\s*/, '')
    .trim()
}

function isNumberedHeading(line: string) {
  return /^\s*(?:#{1,6}\s*|[一二三四五六七八九十百]+[、.．)）]\s+)/.test(line)
}

export function extractPlainTextSection(value: string, headings: string[]) {
  const lines = normalizeLineBreaks(value).split('\n')
  const start = lines.findIndex((line) => {
    const normalized = sectionHeading(line)
    return headings.some((heading) => normalized === heading || normalized.startsWith(`${heading}：`) || normalized.startsWith(`${heading}:`) || normalized.startsWith(`${heading}（`))
  })
  if (start < 0) return ''
  const endOffset = lines.slice(start + 1).findIndex((line) => isNumberedHeading(line))
  const end = endOffset < 0 ? lines.length : start + 1 + endOffset
  return cleanPlainTextOutput(lines.slice(start + 1, end).join('\n'))
}

export function createPrompt(segments: TranscriptSegment[], references: ReferenceDocument[], glossary: GlossaryTerm[], language: Language, recordTemplate: RecordTemplate) {
  const terms = glossary.map((term) => `${term.kind}：${term.canonical}${term.aliases ? `（別名：${term.aliases}）` : ''}${term.locked ? '【已確認，禁止擅改】' : ''}`).join('\n') || '（沒有使用者確認的詞彙）'
  const refs = references.map((reference) => `### ${reference.name}\n${reference.text.slice(0, 8_000)}`).join('\n\n') || '（沒有參考資料）'
  const outputLanguage = language === 'zh' ? '繁體中文（zh-Hant；禁止輸出簡體中文）' : '英文（English）'
  const defaultTemplate = recordTemplate === 'class'
    ? `請整理成一份可直接使用的「課堂筆記」，依序包含：\n課程主題\n日期／授課者（未提及就寫「未提供」）\n一、課程摘要\n二、學習目標\n三、核心概念與定義\n四、各主題重點講解\n五、例子／案例／示範\n六、作業、閱讀或重要提醒\n七、待釐清問題\n請保留教師的論述脈絡與關鍵例子，不要改寫成會議決議格式。`
    : `請整理成一份完整、可直接使用且易讀的「會議記錄摘要」，依序包含：\n會議主題\n日期／時間／地點／與會者（未提及就寫「未提供」）\n一、會議摘要\n二、討論重點（依議題分段）\n三、決議事項與理由\n四、待辦事項（內容、負責人、期限；未提及就寫「未指定」）\n五、未決問題與待確認事項\n六、後續安排`
  const template = recordTemplate === 'memo'
    ? `請整理成一份可直接使用的「工作備忘錄」，依序包含：
工作主題
日期／時間（未提及就寫「未提供」）
一、重點摘要
二、目前進度
三、待處理事項
四、重要決定與備註
五、後續追蹤
只保留逐字稿明確提到的內容，不要自行補造。`
    : recordTemplate === 'experiment'
      ? `請整理成一份「口述實驗記錄」，依序包含：
實驗主題
日期／時間／操作者（未提及就寫「未提供」）
一、實驗目的
二、材料、設備與條件
三、操作步驟
四、觀察結果與數據
五、問題、異常與可能原因
六、結論與後續實驗
缺少的資料請寫「未提供」，不得自行推測。`
      : recordTemplate === 'journal'
        ? `請整理成一份保留個人語氣的「個人日誌」，依序包含：
日期／時間（未提及就寫「未提供」）
一、事件與經過
二、當下想法與感受
三、重要收穫
四、待辦與明日計畫
保留說話者的第一人稱與情緒脈絡，不要把內容改寫成會議記錄。`
        : recordTemplate === 'interview'
          ? `請整理成一份清楚、忠於原意的「採訪/訪談記錄」，依序包含：
訪談主題
日期／時間／地點（未提及就寫「未提供」）
受訪者與背景（未提及就寫「未提供」）
一、訪談摘要
二、重要觀點與引述（保留關鍵原話，不要捏造引述）
三、事件、經驗與脈絡
四、待追問事項
五、後續行動
保留採訪者與受訪者的觀點差異，只根據逐字稿整理，不要自行補充。`
        : defaultTemplate
  return `你是專業的紀錄整理人員。只根據逐字稿、已確認詞彙與參考資料工作，不得虛構姓名、日期、期限、決議、作業或理由。不確定的內容請明確寫「待確認」，不要自行推測。移除口頭贅詞、重複語句與無意義停頓，但保留原意、重要細節、不同觀點與脈絡。輸出語言必須是${outputLanguage}。\n\n${template}\n\n請直接輸出最終純文字文件，不要輸出 JSON、XML、HTML、Markdown、程式碼框、欄位代碼、分析過程、前言或結語。標題使用一般文字，清單使用「•」或中文編號。不要附上原始逐字稿全文。若逐字稿沒有明確的待辦事項或後續安排，對應段落只寫「無」，不得自行補造。\n\n使用者確認詞彙：\n${terms}\n\n參考資料：\n${refs}\n\n逐字稿：\n${transcriptForPrompt(segments)}`
}

function meetingOutputForPrompt(minutes: string) {
  return minutes.slice(0, 16_000)
}

export function createWorkgroupSummaryPrompt(minutes: string, language: Language) {
  const outputLanguage = language === 'zh' ? '繁體中文' : '英文'
  return `你是專業的會議溝通文案。請根據以下已整理好的會議記錄摘要，寫一段適合貼到公司或工作群組的會議記錄摘要，輸出語言為${outputLanguage}。${language === 'zh' ? '中文約 100 字（可落在 80～120 字），' : '請控制在約 70～100 個英文單字，'}讓成員能快速掌握會議重點、重要決議與後續行動。只可使用摘要中明確出現的資訊，不得虛構人名、日期、數字、期限或結論；若沒有待辦事項，不要自行補造。語氣清楚、精簡、自然，適合直接貼上，不要稱呼、標題、Markdown、引號、分析過程或結語，只輸出訊息正文。\n\n已整理好的會議記錄摘要：\n${meetingOutputForPrompt(minutes)}`
}

export function createAnnouncementEmailPrompt(minutes: string, language: Language) {
  const outputLanguage = language === 'zh' ? '繁體中文' : '英文'
  return `你是專業的行政溝通文案。請根據以下已整理好的會議記錄摘要，寫一封可直接寄出的會議紀錄公告信，輸出語言為${outputLanguage}。內容要包含清楚的主旨、簡短禮貌的正文，說明會議摘要已整理完成並以附件提供，並在信末列出「附件：會議記錄摘要」。只可使用摘要中明確出現的資訊，不得虛構人名、日期、決議或期限；不確定的內容請省略，不要自行推測。請輸出純文字，格式為第一行主旨、空一行後接信件正文；不要輸出 Markdown、程式碼框、分析過程或額外說明。\n\n已整理好的會議記錄摘要：\n${meetingOutputForPrompt(minutes)}`
}

export function createGlossaryPrompt(segments: TranscriptSegment[], glossary: GlossaryTerm[], language: Language) {
  const existing = glossary.map((term) => `${term.canonical}${term.aliases ? `（別名：${term.aliases}）` : ''}`).join('、') || '（目前沒有既有詞彙）'
  const outputLanguage = language === 'zh' ? '繁體中文' : '英文'
  return `你是專業的逐字稿詞彙校正助手。請只根據以下逐字稿，找出可能的誤聽、錯字、專有名詞或同一詞彙的不同寫法，提出保守的修正建議。不得虛構逐字稿沒有出現的人名、產品名或術語；沒有明確修正時輸出空陣列。輸出語言為${outputLanguage}。\n\n只輸出 JSON 陣列，不要輸出 Markdown 或其他文字，格式如下：[{"original":"逐字稿中的原詞","suggested":"建議詞彙","reason":"簡短修正理由"}]。original 必須確實出現在逐字稿，suggested 必須與 original 不同；最多 30 筆。\n\n目前詞彙表：\n${existing}\n\n逐字稿：\n${transcriptForPrompt(segments)}`
}

export function createPolishedTranscriptPrompt(segments: TranscriptSegment[], language: Language) {
  const outputLanguage = language === 'zh' ? '繁體中文' : '英文'
  const rows = segments.map((segment, index) => `${index}: ${segment.text}`).join('\n').slice(0, 28_000)
  return `請校正文句並整理以下逐字稿，輸出語言為${outputLanguage}。只修正口語贅詞、明顯錯字、重複語句與不自然表達，不得新增逐字稿沒有提到的事實、人名、數字或結論。保留每一段的原本順序與語意。只輸出 JSON 陣列，格式為 [{"index":0,"text":"修飾後文字"}]；index 必須對應原段落，不能遺漏段落。\n\n逐字稿段落：\n${rows}`
}

export function parsePolishedTranscript(value: string, original: TranscriptSegment[]) {
  const match = normalizeLineBreaks(value).match(/\[[\s\S]*\]/)
  if (!match) return original
  try {
    const parsed = JSON.parse(match[0]) as unknown
    if (!Array.isArray(parsed)) return original
    const byIndex = new Map(parsed.flatMap((row) => {
      if (!row || typeof row !== 'object') return []
      const item = row as Record<string, unknown>
      const index = Number(item.index)
      const text = String(item.text ?? '').trim()
      return Number.isInteger(index) && text ? [[index, text] as const] : []
    }))
    return original.map((segment, index) => ({ ...segment, text: byIndex.get(index) ?? segment.text }))
  } catch {
    return original
  }
}

export function parseGlossarySuggestions(value: string): GlossarySuggestion[] {
  const text = normalizeLineBreaks(value).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  const match = text.match(/\[[\s\S]*\]/) || text.match(/\{[\s\S]*\}/)
  if (!match) return []
  try {
    const parsed = JSON.parse(match[0]) as unknown
    const rows = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object'
        ? ((parsed as Record<string, unknown>).suggestions ?? (parsed as Record<string, unknown>).terms ?? [])
        : []
    if (!Array.isArray(rows)) return []
    return rows.map((row) => {
      if (!row || typeof row !== 'object') return null
      const item = row as Record<string, unknown>
      const original = String(item.original ?? item.from ?? item.term ?? '').trim()
      const suggested = String(item.suggested ?? item.to ?? item.correction ?? '').trim()
      const reason = String(item.reason ?? '').trim()
      return original && suggested && original !== suggested ? { original, suggested, reason } : null
    }).filter((item): item is GlossarySuggestion => Boolean(item)).slice(0, 30)
  } catch {
    return []
  }
}
