import * as pdfjsLib from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { ReferenceDocument } from '../types'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

export async function readReference(file: File): Promise<ReferenceDocument> {
  const id = crypto.randomUUID()
  if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
    const data = new Uint8Array(await file.arrayBuffer())
    const pdf = await pdfjsLib.getDocument({ data }).promise
    const pages: string[] = []
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber)
      const content = await page.getTextContent()
      const text = content.items.map((item: any) => item.str || '').join(' ').replace(/\s+/g, ' ').trim()
      pages.push(`[第 ${pageNumber} 頁]\n${text}`)
    }
    return { id, name: file.name, type: 'pdf', pages: pdf.numPages, text: pages.join('\n\n'), size: file.size }
  }
  const text = await file.text()
  return { id, name: file.name, type: 'text', text, size: file.size }
}

export function relevantReferenceText(text: string, query: string, maxChars = 8_000) {
  if (text.length <= maxChars) return text
  const terms = query.split(/\s+/).filter((term) => term.length >= 2).slice(0, 12)
  const lines = text.split(/\n+/)
  const selected = lines.filter((line) => terms.some((term) => line.includes(term))).slice(0, 80)
  return (selected.length ? selected.join('\n') : text.slice(0, maxChars)).slice(0, maxChars)
}
