import type { Language, TranscriptSegment } from '../types'

type Progress = { status?: string; progress?: number; file?: string; phase?: 'model' | 'transcribing'; indeterminate?: boolean }
type WorkerResponse =
  | { status: 'progress'; data: Progress }
  | { status: 'ready' }
  | { status: 'partial'; data: { text?: string } }
  | { status: 'complete'; data: { text?: string; chunks?: Array<{ text?: string; timestamp?: [number, number] }> } }
  | { status: 'error'; data: { message: string } }

let transcriptionWorker: Worker | null = null

function modelForLanguage(language: Language, size: 'tiny' | 'base' | 'medium') {
  return language === 'en' ? `Xenova/whisper-${size}.en` : `Xenova/whisper-${size}`
}

function getWorker() {
  if (!transcriptionWorker) {
    transcriptionWorker = new Worker(new URL('./transcription.worker.ts', import.meta.url), { type: 'module' })
  }
  return transcriptionWorker
}

function liveSegments(text: string): TranscriptSegment[] {
  const sentences = text.match(/[^。！？!?；;\.\n]+(?:[。！？!?；;\.]|$)/g) ?? []
  return sentences.map((sentence) => sentence.trim()).filter(Boolean).map((sentence, index) => ({
    id: `live-segment-${index}`,
    start: -1,
    end: -1,
    text: sentence,
    originalText: sentence,
  }))
}

async function decodeAudio(file: Blob): Promise<Float32Array> {
  const data = await file.arrayBuffer()
  const context = new AudioContext({ sampleRate: 16_000 })
  try {
    const decoded = await context.decodeAudioData(data.slice(0))
    const channel = decoded.getChannelData(0)
    if (decoded.sampleRate === 16_000) return new Float32Array(channel)
    const ratio = 16_000 / decoded.sampleRate
    const length = Math.floor(channel.length * ratio)
    const output = new Float32Array(length)
    for (let index = 0; index < length; index += 1) {
      output[index] = channel[Math.min(channel.length - 1, Math.floor(index / ratio))]
    }
    return output
  } finally {
    await context.close()
  }
}

export async function transcribe(file: Blob, language: Language, size: 'tiny' | 'base' | 'medium', onProgress: (progress: Progress) => void, onSegments?: (segments: TranscriptSegment[]) => void): Promise<TranscriptSegment[]> {
  const audio = await decodeAudio(file)
  const model = modelForLanguage(language, size)
  const worker = getWorker()
  onProgress({ status: `正在準備 ${model}（瀏覽器背景執行緒）…`, progress: 0, phase: 'model', indeterminate: true })

  const result = await new Promise<{ text?: string; chunks?: Array<{ text?: string; timestamp?: [number, number] }> }>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data
      if (message.status === 'progress') {
        onProgress(message.data)
      } else if (message.status === 'ready') {
        // Transformers.js reports model-loading progress, but inference itself
        // does not expose a reliable percentage. Use an indeterminate bar so
        // the UI communicates that work is still progressing instead of being
        // stuck at a misleading 0%.
        onProgress({ status: '正在辨識語音…', progress: 0, phase: 'transcribing', indeterminate: true })
      } else if (message.status === 'partial') {
        onSegments?.(liveSegments(String(message.data.text ?? '')))
      } else if (message.status === 'complete') {
        resolve(message.data)
      } else if (message.status === 'error') {
        reject(new Error(message.data.message))
      }
    }
    worker.onerror = (event) => {
      transcriptionWorker?.terminate()
      transcriptionWorker = null
      reject(new Error(event.message || '語音模型背景執行緒載入失敗。'))
    }
    worker.postMessage({ type: 'transcribe', audio, model, language: language === 'zh' ? 'chinese' : 'english' }, [audio.buffer])
  })
  const chunks = Array.isArray(result?.chunks) ? result.chunks : []
  if (!chunks.length) {
    const text = String(result?.text ?? '').trim()
    const segments = text ? [{ id: crypto.randomUUID(), start: 0, end: 0, text, originalText: text }] : []
    onSegments?.(segments)
    return segments
  }
  const segments = chunks.map((chunk: any, index: number) => {
    const timestamp = Array.isArray(chunk.timestamp) ? chunk.timestamp : [0, 0]
    const text = String(chunk.text ?? '').trim()
    return { id: crypto.randomUUID?.() ?? `segment-${index}`, start: Number(timestamp[0] ?? 0), end: Number(timestamp[1] ?? timestamp[0] ?? 0), text, originalText: text }
  }).filter((segment: TranscriptSegment) => segment.text)
  onSegments?.(segments)
  return segments
}
