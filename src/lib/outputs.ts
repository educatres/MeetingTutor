import type { GlossaryTerm, Language, MeetingOutput, ReferenceDocument, TranscriptSegment } from '../types'

const escapeHtml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
const textLines = (segments: TranscriptSegment[]) => segments.map((segment) => `[${formatTime(segment.start)}] ${segment.speaker ? `${segment.speaker}: ` : ''}${segment.text}`).join('\n')
const formatTime = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds <= 0) return '00:00'
  const minutes = Math.floor(seconds / 60).toString().padStart(2, '0')
  const secs = Math.floor(seconds % 60).toString().padStart(2, '0')
  return `${minutes}:${secs}`
}

function transcriptForPrompt(segments: TranscriptSegment[]) {
  return segments.map((segment) => `${formatTime(segment.start)} ${segment.speaker || '未指定說話者'}：${segment.text}`).join('\n').slice(0, 28_000)
}

export function createPrompt(segments: TranscriptSegment[], references: ReferenceDocument[], glossary: GlossaryTerm[], language: Language) {
  const terms = glossary.map((term) => `${term.kind}：${term.canonical}${term.aliases ? `（別名：${term.aliases}）` : ''}${term.locked ? '【已確認，禁止擅改】' : ''}`).join('\n') || '（沒有使用者確認的詞彙）'
  const refs = references.map((reference) => `### ${reference.name}\n${reference.text.slice(0, 8_000)}`).join('\n\n') || '（沒有參考資料）'
  const outputLanguage = language === 'zh' ? '繁體中文（zh-Hant；禁止輸出簡體中文）' : '英文（English）'
  return `你是 MeetingTutor 的會議文件整理助理。只根據逐字稿與參考資料工作，不得虛構姓名、日期、期限、決議、投票或理由。使用者確認的詞彙不可擅自改寫；不確定的姓名與專有名詞請列入 uncertainties，保留原文。先做語句修飾，再提供可追溯的變更與來源。所有 revisedText、變更理由、待確認事項與會議文件內容必須使用${outputLanguage}。\n\n請只回傳 JSON，符合：{"revisedText":"...","changes":[{"from":"...","to":"...","reason":"...","confidence":"high|medium|low"}],"terms":[{"source":"...","suggested":"...","status":"confirmed|candidate|uncertain","evidence":["..."]}],"uncertainties":["..."],"evidence":[{"claim":"...","source":"transcript#segment"}]}。\n\n使用者確認詞彙：\n${terms}\n\n參考資料：\n${refs}\n\n逐字稿：\n${transcriptForPrompt(segments)}`
}

export function renderTableHtml(title: string, summary: string[], headers: string[], rows: string[][], notes: string[] = []) {
  const summaryHtml = summary.filter(Boolean).map((line) => `<p>${escapeHtml(line)}</p>`).join('')
  const headerHtml = headers.map((header) => `<th scope="col">${escapeHtml(header)}</th>`).join('')
  const rowsHtml = rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')
  const notesHtml = notes.length ? `<section><h2>補充說明</h2><ul>${notes.map((note) => `<li>${escapeHtml(note)}</li>`).join('')}</ul></section>` : ''
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>*{box-sizing:border-box}@page{size:A4 landscape;margin:14mm}body{margin:0;background:#eef2f4;color:#202833;font-family:"Noto Sans TC","Microsoft JhengHei","PingFang TC",sans-serif;line-height:1.55}main{width:min(1180px,calc(100% - 24px));margin:12px auto;padding:24px;background:#fff;box-shadow:0 2px 14px #ccd5da}h1{margin:0 0 16px;color:#1e4058;font-size:24px}h2{font-size:17px}.summary{margin-bottom:16px;color:#485b67}.summary p{margin:3px 0}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;font-size:14px}th,td{padding:9px 10px;border:1px solid #aebdc5;text-align:left;vertical-align:top}th{background:#dfeef3;color:#1e4058;white-space:nowrap}tr:nth-child(even) td{background:#f7fafb}li{margin:4px 0}@media print{body{background:#fff}main{width:auto;margin:0;padding:0;box-shadow:none}.table-wrap{overflow:visible}tr{break-inside:avoid}}</style></head><body><main><h1>${escapeHtml(title)}</h1><div class="summary">${summaryHtml}</div><div class="table-wrap"><table><thead><tr>${headerHtml}</tr></thead><tbody>${rowsHtml}</tbody></table></div>${notesHtml}</main></body></html>`
}

function htmlMainContent(document: string) {
  return document.match(/<main[^>]*>([\s\S]*?)<\/main>/i)?.[1] ?? `<pre>${escapeHtml(document)}</pre>`
}

export function localOutputs(segments: TranscriptSegment[], references: ReferenceDocument[], glossary: GlossaryTerm[]): MeetingOutput {
  const transcript = textLines(segments) || '（尚未取得逐字稿）'
  const glossaryText = glossary.length ? glossary.map((term) => `• ${term.kind}：${term.canonical}${term.aliases ? `（別名：${term.aliases}）` : ''}`).join('\n') : '• 尚未建立詞彙表'
  const sourceText = references.length ? references.map((reference) => `${reference.name}（${reference.type === 'pdf' ? `${reference.pages ?? 0} 頁` : '文字'}）`).join('、') : '未提供'
  const notice = `主旨：【會後通知】會議名稱待確認｜日期待確認\n\n各位好：\n\n以下為尚未經人工確認的會議整理草稿。\n\n一、會議決議\n• 尚未由模型／人工確認。\n\n二、待辦事項\n任務編號：ACT-DATE-UNKNOWN-01\n待辦事項：請人工檢閱逐字稿並補充會議決議\n負責人：待指定\n完成標準：完成一份核准的會議紀錄\n期限：待確認\n\n三、尚待確認事項\n• 會議名稱、日期、出席者、決議、負責人與期限。\n\n四、下次會議\n日期與時間：待安排\n預計討論：檢閱未決事項與待辦。\n\n如上述內容有需修正之處，請回覆提出；謝謝大家。`
  const minutes = `會議名稱待確認｜會議紀錄\n\n會議日期／時間：待確認\n地點：未提供\n主席：未提供\n紀錄：未提供\n出席／列席：未提供\n資料來源：逐字稿；參考資料：${sourceText}\n\n一、會議摘要\n目前僅建立可供人工檢閱的草稿，尚未將任何討論內容標記為正式決議。\n\n二、逐字稿\n${transcript}\n\n三、詞彙與姓名參考\n${glossaryText}\n\n四、決策與理由\n• DEC-DATE-UNKNOWN-01｜尚未確認的決策：狀態：未決；決策內容、理由與未採用方案：未提及。\n\n五、未決問題與待確認事項\n• 請補充會議名稱、日期、參與者、決議、主責人與期限。\n\n六、下次會議\n待安排。`
  const actions = renderTableHtml('待辦追蹤表', [], ['任務編號', '待辦事項', '主責人', '協作人', '完成標準', '期限', '狀態', '關聯決策', '來源會議', '備註／阻礙'], [['ACT-DATE-UNKNOWN-01', '檢閱逐字稿並補充會議資料', '待指定', '無', '完成核准會議紀錄', '待確認', '未開始', 'DEC-DATE-UNKNOWN-01', '會議名稱待確認', '尚未確認會議基本資料']])
  const agenda = renderTableHtml('下次會議議程（草稿）', ['預定日期：待安排', '承接會議：會議名稱待確認｜日期待確認', '會議目標：確認會議基本資料、決策、待辦主責與期限。'], ['優先序', '議題', '背景／待解問題', '事前準備／負責人', '預期產出', '關聯編號'], [['1', '補充並確認會議資料', '目前資料不足，無法判定正式決議', '請相關人員提供', '核准會議紀錄', 'DEC-DATE-UNKNOWN-01／ACT-DATE-UNKNOWN-01']], ['提供會議名稱、日期、出席者、決議、負責人、完成標準與期限。'])
  return { notice, minutes, actions, agenda, a4Html: renderA4Html(notice, minutes, actions, agenda, sourceText) }
}

export function renderA4Html(notice: string, minutes: string, actions: string, agenda: string, sourceText = '未提供') {
  const pre = (value: string) => `<pre>${escapeHtml(value)}</pre>`
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>MeetingTutor｜會議成果彙整</title><style>*{box-sizing:border-box}@page{size:A4 portrait;margin:16mm 15mm 16mm 15mm}body{margin:0;color:#202833;font-family:"Noto Sans TC","Microsoft JhengHei","PingFang TC",sans-serif;font-size:10.5pt;line-height:1.55}main{width:210mm;max-width:100%;margin:0 auto;padding:16mm 15mm;background:#fff}h1{font-size:20pt;margin:0 0 5mm}h2{font-size:13pt;margin:8mm 0 3mm;padding-bottom:2mm;border-bottom:1px solid #aab3bd}pre{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere;margin:0;padding:3mm;background:#f7f8fa;border-left:2px solid #7b8794}p{margin:0 0 2.5mm}.muted{color:#596675}.embedded-document h1{font-size:13pt;margin:0 0 3mm}.embedded-document .summary{margin-bottom:3mm}.embedded-document .table-wrap{overflow:visible}.embedded-document table{width:100%;border-collapse:collapse;font-size:8pt}.embedded-document th,.embedded-document td{padding:1.5mm;border:1px solid #aebdc5;text-align:left;vertical-align:top}.embedded-document th{background:#dfeef3}.embedded-document section h2{font-size:11pt;margin-top:4mm}@media print{main{width:auto;max-width:none;margin:0;padding:0}.screen-only{display:none!important}pre{break-inside:auto}tr{break-inside:avoid}}@media screen{body{background:#f3f5f7}main{margin:12px auto 25px;box-shadow:0 2px 15px #d8dde2}}</style></head><body><main><div class="screen-only"><button onclick="window.print()">列印／另存 PDF</button></div><h1>會議名稱待確認｜會議成果彙整</h1><p class="muted">資料來源：${escapeHtml(sourceText)}｜文件狀態：草稿，請人工核准</p><h2>一、會後通知信（草稿）</h2>${pre(notice)}<h2>二、完整會議紀錄與決策脈絡</h2>${pre(minutes)}<h2>三、待辦追蹤</h2><div class="embedded-document">${htmlMainContent(actions)}</div><h2>四、下次會議議程</h2><div class="embedded-document">${htmlMainContent(agenda)}</div><h2>附錄｜待確認事項</h2><p>本文件中的會議名稱、日期、決策、待辦主責與期限均需依原始資料確認；不可將 AI 建議視為正式決議。</p></main></body></html>`
}
