import type { GlossaryTerm, Language, ReferenceDocument, TranscriptSegment } from '../types'

export const normalizeLineBreaks = (value: string) => value.replace(/\\r\\n|\\n|\\r/g, '\n').replace(/\r\n?/g, '\n')
const escapeHtml = (value: string) => normalizeLineBreaks(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
const htmlText = (value: string) => escapeHtml(value).replace(/\n/g, '<br>')
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

export function createPrompt(segments: TranscriptSegment[], references: ReferenceDocument[], glossary: GlossaryTerm[], language: Language, recordTemplate: 'meeting' | 'class') {
  const terms = glossary.map((term) => `${term.kind}：${term.canonical}${term.aliases ? `（別名：${term.aliases}）` : ''}${term.locked ? '【已確認，禁止擅改】' : ''}`).join('\n') || '（沒有使用者確認的詞彙）'
  const refs = references.map((reference) => `### ${reference.name}\n${reference.text.slice(0, 8_000)}`).join('\n\n') || '（沒有參考資料）'
  const outputLanguage = language === 'zh' ? '繁體中文（zh-Hant；禁止輸出簡體中文）' : '英文（English）'
  const template = recordTemplate === 'class'
    ? `請整理成一份可直接使用的「課堂筆記」，依序包含：\n課程主題\n日期／授課者（未提及就寫「未提供」）\n一、課程摘要\n二、學習目標\n三、核心概念與定義\n四、各主題重點講解\n五、例子／案例／示範\n六、作業、閱讀或重要提醒\n七、待釐清問題\n請保留教師的論述脈絡與關鍵例子，不要改寫成會議決議格式。`
    : `請整理成一份完整、可直接使用且易讀的「會議記錄摘要」，依序包含：\n會議主題\n日期／時間／地點／與會者（未提及就寫「未提供」）\n一、會議摘要\n二、討論重點（依議題分段）\n三、決議事項與理由\n四、待辦事項（內容、負責人、期限；未提及就寫「未指定」）\n五、未決問題與待確認事項\n六、後續安排`
  return `你是專業的紀錄整理人員。只根據逐字稿、已確認詞彙與參考資料工作，不得虛構姓名、日期、期限、決議、作業或理由。不確定的內容請明確寫「待確認」，不要自行推測。移除口頭贅詞、重複語句與無意義停頓，但保留原意、重要細節、不同觀點與脈絡。輸出語言必須是${outputLanguage}。\n\n${template}\n\n請直接輸出最終純文字文件，不要輸出 JSON、XML、HTML、Markdown、程式碼框、欄位代碼、分析過程、前言或結語。標題使用一般文字，清單使用「•」或中文編號。不要附上原始逐字稿全文。\n\n使用者確認詞彙：\n${terms}\n\n參考資料：\n${refs}\n\n逐字稿：\n${transcriptForPrompt(segments)}`
}

export function renderTableHtml(title: string, summary: string[], headers: string[], rows: string[][], notes: string[] = []) {
  const summaryHtml = summary.filter(Boolean).map((line) => `<p>${htmlText(line)}</p>`).join('')
  const headerHtml = headers.map((header) => `<th scope="col">${escapeHtml(header)}</th>`).join('')
  const rowsHtml = rows.map((row) => `<tr>${row.map((cell) => `<td>${htmlText(cell)}</td>`).join('')}</tr>`).join('')
  const notesHtml = notes.length ? `<section><h2>補充說明</h2><ul>${notes.map((note) => `<li>${htmlText(note)}</li>`).join('')}</ul></section>` : ''
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>*{box-sizing:border-box}body{margin:0;background:#eef2f4;color:#202833;font-family:"Noto Sans TC","Microsoft JhengHei","PingFang TC",sans-serif;line-height:1.55}main{width:min(1180px,calc(100% - 24px));margin:12px auto;padding:24px;background:#fff;box-shadow:0 2px 14px #ccd5da}h1{margin:0 0 16px;color:#1e4058;font-size:24px}h2{font-size:17px}.summary{margin-bottom:16px;color:#485b67}.summary p{margin:3px 0}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;font-size:14px}th,td{padding:9px 10px;border:1px solid #aebdc5;text-align:left;vertical-align:top}th{background:#dfeef3;color:#1e4058;white-space:nowrap}tr:nth-child(even) td{background:#f7fafb}li{margin:4px 0}@media print{body{background:#fff}main{width:auto;margin:0;padding:0;box-shadow:none}.table-wrap{overflow:visible}tr{break-inside:avoid}}</style></head><body><main><h1>${escapeHtml(title)}</h1><div class="summary">${summaryHtml}</div><div class="table-wrap"><table><thead><tr>${headerHtml}</tr></thead><tbody>${rowsHtml}</tbody></table></div>${notesHtml}</main></body></html>`
}
