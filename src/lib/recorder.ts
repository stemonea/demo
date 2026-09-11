import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * The microphone, and the one shape the service accepts.
 *
 * A browser will record to whatever container it feels like - webm/opus on
 * Chrome, mp4/aac on Safari - and none of them is something a Python service
 * can open without ffmpeg on the path. So the conversion happens here, using
 * the audio engine the browser already has: the recording is decoded, resampled
 * to the rate Whisper is trained at, mixed to one channel and written out as
 * plain 16-bit PCM in a WAV container. The service then reads it with the
 * standard library and has no decoder to keep working.
 */

/** What Whisper is trained at; the service refuses anything else. */
export const TARGET_RATE = 16_000

export type RecorderPhase = 'idle' | 'asking' | 'recording' | 'blocked'

export interface Recording {
  wav: Blob
  seconds: number
}

/* ------------------------------------------------------------------ *
 * WAV                                                                 *
 * ------------------------------------------------------------------ */

/** 16-bit PCM in a WAV container: the header, then the samples. */
export function encodeWav(samples: Float32Array, rate: number): Blob {
  const bytes = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(bytes)

  const ascii = (at: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(at + i, text.charCodeAt(i))
  }

  ascii(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true) // PCM header length
  view.setUint16(20, 1, true) // PCM, uncompressed
  view.setUint16(22, 1, true) // one channel
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true) // bytes per second
  view.setUint16(32, 2, true) // bytes per frame
  view.setUint16(34, 16, true) // bits per sample
  ascii(36, 'data')
  view.setUint32(40, samples.length * 2, true)

  for (let i = 0; i < samples.length; i += 1) {
    /* clamped before scaling: a sample past ±1 would wrap and click */
    const clamped = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(44 + i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
  }

  return new Blob([bytes], { type: 'audio/wav' })
}

/**
 * Whatever the recorder produced, as mono at the target rate.
 *
 * `OfflineAudioContext` does the resampling: rendering the decoded buffer into
 * a context that runs at 16 kHz is a resample, and connecting a multi-channel
 * source to a one-channel destination is a downmix. Both are the browser's own,
 * which is the point - hand-rolling either is how a recording ends up sounding
 * like a fax machine.
 */
export async function toMono16k(recorded: Blob): Promise<Float32Array> {
  const bytes = await recorded.arrayBuffer()

  const AudioCtx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
  const decoder = new AudioCtx()
  let decoded: AudioBuffer
  try {
    decoded = await decoder.decodeAudioData(bytes)
  } finally {
    void decoder.close()
  }

  const frames = Math.max(1, Math.ceil(decoded.duration * TARGET_RATE))
  const offline = new OfflineAudioContext(1, frames, TARGET_RATE)
  const source = offline.createBufferSource()
  source.buffer = decoded
  source.connect(offline.destination)
  source.start()

  const rendered = await offline.startRendering()
  return rendered.getChannelData(0)
}

/* ------------------------------------------------------------------ *
 * The microphone                                                      *
 * ------------------------------------------------------------------ */

export interface Recorder {
  phase: RecorderPhase
  /** 0…1, how loud it is right now - the meter, and the proof it is listening */
  level: number
  /** how long the microphone has been open, in seconds */
  seconds: number
  error: string | null
  /** opens the microphone; false when it was refused or is not there */
  open: () => Promise<boolean>
  /** closes the microphone and hands back the turn, ready to send */
  close: () => Promise<Recording | null>
  cancel: () => void
}

/**
 * One turn at a time.
 *
 * The microphone is opened for a single speaker and closed again, and closing
 * it is what produces the turn - there is no continuous stream to segment and
 * no diarisation to get wrong, because the person running the session says who
 * is about to talk. The permission prompt is only ever raised on `open`, so
 * nothing asks for a microphone until someone presses the button.
 */
export function useRecorder(): Recorder {
  const [phase, setPhase] = useState<RecorderPhase>('idle')
  const [level, setLevel] = useState(0)
  const [seconds, setSeconds] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const streamRef = useRef<MediaStream | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const meterRef = useRef<{ ctx: AudioContext; raf: number } | null>(null)
  const startedRef = useRef(0)

  /* whatever happens, the microphone light goes out */
  const release = useCallback(() => {
    if (meterRef.current) {
      cancelAnimationFrame(meterRef.current.raf)
      void meterRef.current.ctx.close()
      meterRef.current = null
    }
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    recorderRef.current = null
    setLevel(0)
  }, [])

  useEffect(() => release, [release])

  /* the elapsed counter, while the microphone is open */
  useEffect(() => {
    if (phase !== 'recording') return
    const tick = setInterval(() => setSeconds((performance.now() - startedRef.current) / 1000), 100)
    return () => clearInterval(tick)
  }, [phase])

  const open = useCallback(async (): Promise<boolean> => {
    setError(null)
    setPhase('asking')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
      streamRef.current = stream

      const recorder = new MediaRecorder(stream)
      chunksRef.current = []
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunksRef.current.push(event.data)
      }
      recorder.start()
      recorderRef.current = recorder

      /* the meter: the loudness of the last frame, read off the live stream so
         a speaker can see they are being heard before they trust the recording */
      const AudioCtx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      const ctx = new AudioCtx()
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 1024
      ctx.createMediaStreamSource(stream).connect(analyser)
      const frame = new Float32Array(analyser.fftSize)
      /*
       * One chain, not two.
       *
       * Scheduling a frame and then calling `read` straight away started the
       * loop twice: the second call overwrote the handle of the first, so
       * `release` could only ever cancel one of them and the other went on
       * reading a closed audio context at sixty frames a second for the rest
       * of the session. The loop schedules its own successor, so starting it
       * once is starting it.
       */
      const read = () => {
        analyser.getFloatTimeDomainData(frame)
        let sum = 0
        for (let i = 0; i < frame.length; i += 1) sum += frame[i] * frame[i]
        setLevel(Math.min(1, Math.sqrt(sum / frame.length) * 4))
        meterRef.current = { ctx, raf: requestAnimationFrame(read) }
      }
      meterRef.current = { ctx, raf: requestAnimationFrame(read) }

      startedRef.current = performance.now()
      setSeconds(0)
      setPhase('recording')
      return true
    } catch (cause) {
      release()
      setPhase('blocked')
      const name = (cause as Error).name
      setError(
        name === 'NotAllowedError'
          ? 'The microphone was refused. Allow it for this page and press record again.'
          : name === 'NotFoundError'
            ? 'No microphone was found on this machine.'
            : `The microphone could not be opened: ${(cause as Error).message}`,
      )
      /*
       * Said, not only recorded.
       *
       * This used to swallow the refusal and resolve like a success, and the
       * page that called it had no way of knowing: it set itself to "listening"
       * next to the error explaining that the microphone had been refused, and
       * offered a stop button for a recording that did not exist.
       */
      return false
    }
  }, [release])

  const close = useCallback(async (): Promise<Recording | null> => {
    const recorder = recorderRef.current
    if (!recorder || recorder.state === 'inactive') {
      release()
      setPhase('idle')
      return null
    }

    const recorded = await new Promise<Blob>((resolve) => {
      recorder.onstop = () => resolve(new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' }))
      recorder.stop()
    })
    release()
    setPhase('idle')

    if (!recorded.size) return null

    const samples = await toMono16k(recorded)
    return { wav: encodeWav(samples, TARGET_RATE), seconds: samples.length / TARGET_RATE }
  }, [release])

  const cancel = useCallback(() => {
    const recorder = recorderRef.current
    if (recorder && recorder.state !== 'inactive') {
      recorder.onstop = null
      recorder.stop()
    }
    release()
    setPhase('idle')
  }, [release])

  return { phase, level, seconds, error, open, close, cancel }
}
