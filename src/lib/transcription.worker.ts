import { env, pipeline, WhisperTextStreamer } from '@huggingface/transformers'

type WorkerScope = {
  onmessage: ((event: MessageEvent) => void) | null
  postMessage: (message: unknown) => void
}

const workerScope = globalThis as unknown as WorkerScope
// Reuse model files through the browser Cache API between page loads.
env.useBrowserCache = true
env.allowRemoteModels = true
env.allowLocalModels = false
let currentModel = ''
type Transcriber = ((audio: Float32Array, options: Record<string, unknown>) => Promise<any>) & { tokenizer: ConstructorParameters<typeof WhisperTextStreamer>[0] }
let currentTranscriber: Transcriber | null = null

async function getTranscriber(model: string) {
  if (!currentTranscriber || currentModel !== model) {
    currentModel = model
    const createPipeline = pipeline as unknown as (task: string, model: string, options: Record<string, unknown>) => Promise<unknown>
    currentTranscriber = await createPipeline('automatic-speech-recognition', model, {
      quantized: true,
      progress_callback: (progress: { status?: string; progress?: number; file?: string }) => {
        const status = progress.status === 'initiate'
          ? `開始下載模型檔：${progress.file ?? ''}`
          : progress.status === 'progress'
            ? `下載模型檔：${progress.file ?? ''}`
            : progress.status === 'done'
              ? `模型檔下載完成：${progress.file ?? ''}`
              : progress.status
        workerScope.postMessage({ status: 'progress', data: { ...progress, status, phase: 'model', indeterminate: typeof progress.progress !== 'number' } })
      },
    }) as unknown as Transcriber
  }
  return currentTranscriber
}

workerScope.onmessage = async (event) => {
  const message = event.data as { type?: string; audio?: Float32Array; model?: string; language?: string }
  if (message.type !== 'transcribe' || !message.audio || !message.model) return
  try {
    const transcriber = await getTranscriber(message.model)
    workerScope.postMessage({ status: 'ready' })
    let streamedText = ''
    const streamer = new WhisperTextStreamer(transcriber.tokenizer, {
      skip_prompt: true,
      callback_function: (text: string) => {
        streamedText += text
        workerScope.postMessage({ status: 'partial', data: { text: streamedText } })
      },
    })
    const result = await transcriber(message.audio, {
      top_k: 0,
      do_sample: false,
      chunk_length_s: 30,
      stride_length_s: 5,
      language: message.language,
      task: 'transcribe',
      return_timestamps: true,
      streamer,
    })
    workerScope.postMessage({ status: 'complete', data: result })
  } catch (error) {
    workerScope.postMessage({ status: 'error', data: { message: error instanceof Error ? error.message : String(error) } })
  }
}
