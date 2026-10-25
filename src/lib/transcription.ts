import { pipeline } from '@huggingface/transformers'
import type { Language, TranscriptSegment } from '../types'

type Progress = { status?: string; progress?: number; file?: string }
type ASRPipeline = (audio: Float32Array, options: Record<string, unknown>) => Promise<any>

let currentPipeline: { model: string; pipe: ASRPipeline } | null = null

function modelForLanguage(language: Language, size: 'tiny' | 'base') {
  return language === 'en' ? `Xenova/whisper-${size}.en` : `Xenova/whisper-${size}`
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

export async function transcribe(file: Blob, language: Language, size: 'tiny' | 'base', onProgress: (progress: Progress) => void): Promise<TranscriptSegment[]> {
  const model = modelForLanguage(language, size)
  if (!currentPipeline || currentPipeline.model !== model) {
    onProgress({ status: '正在下載語音模型…', progress: 0 })
    const pipe = await pipeline('automatic-speech-recognition', model, {
      dtype: 'q8',
      device: 'wasm',
      progress_callback: onProgress,
    }) as unknown as ASRPipeline
    currentPipeline = { model, pipe }
  }
  const audio = await decodeAudio(file)
  onProgress({ status: '正在辨識語音…', progress: 0 })
  const result = await currentPipeline.pipe(audio, {
    return_timestamps: true,
    chunk_length_s: 30,
    stride_length_s: 5,
    language: language === 'zh' ? 'chinese' : 'english',
    task: 'transcribe',
  })
  const chunks = Array.isArray(result?.chunks) ? result.chunks : []
  if (!chunks.length) {
    const text = String(result?.text ?? '').trim()
    return text ? [{ id: crypto.randomUUID(), start: 0, end: 0, text, originalText: text }] : []
  }
  return chunks.map((chunk: any, index: number) => {
    const timestamp = Array.isArray(chunk.timestamp) ? chunk.timestamp : [0, 0]
    const text = String(chunk.text ?? '').trim()
    return { id: crypto.randomUUID?.() ?? `segment-${index}`, start: Number(timestamp[0] ?? 0), end: Number(timestamp[1] ?? timestamp[0] ?? 0), text, originalText: text }
  }).filter((segment: TranscriptSegment) => segment.text)
}
