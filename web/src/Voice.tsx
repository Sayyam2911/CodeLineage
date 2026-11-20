import { useEffect, useRef, useState } from 'react'
import type { IAgoraRTCClient, IMicrophoneAudioTrack, IRemoteAudioTrack } from 'agora-rtc-sdk-ng'
import { AudioLines, LoaderCircle, Mic, PhoneOff, RotateCcw, Square, Volume2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { allowVoicePlayback, voiceRtc, waitForInterviewer, type VoiceRoom } from '@/lib/voice-media'
import { request } from './api'
import type { ChangeOptions } from './api'

type AnswerPhase = 'ready' | 'opening' | 'recording' | 'submitting' | 'waiting'
type Call = {
  room?: VoiceRoom
  rtc?: IAgoraRTCClient
  remote?: IRemoteAudioTrack
  track?: IMicrophoneAudioTrack
  cleanupPlayback?: () => void
  phase: AnswerPhase
  topicId?: string
  topicVersion?: number
  prompted?: string
}

export function useInterviewVoice({ sessionId, token, enabled, autoConnect, topicId, topicVersion, announceTopic, paused }: {
  sessionId: string
  token: string
  enabled: boolean
  autoConnect: boolean
  topicId?: string
  topicVersion: number
  announceTopic: boolean
  paused: boolean
}) {
  const [available, setAvailable] = useState<boolean | null>(null)
  const [connection, setConnection] = useState<'idle' | 'joining' | 'connected' | 'leaving'>('idle')
  const [phase, setPhase] = useState<AnswerPhase>('ready')
  const [speaking, setSpeaking] = useState(false)
  const [presenting, setPresenting] = useState(false)
  const [blocked, setBlocked] = useState(false)
  const [error, setError] = useState('')
  const live = useRef<Call | null>(null)
  const playbackPaused = useRef(paused)
  const autoAttempted = useRef(false)
  const meter = useRef<HTMLDivElement>(null)
  const promptTimer = useRef<number | undefined>(undefined)
  const prefix = '/voice/sessions/' + sessionId

  function step(call: Call, next: AnswerPhase) {
    call.phase = next
    if (live.current === call) setPhase(next)
  }

  async function disconnect(call: Call) {
    if (live.current === call) live.current = null
    const { room, rtc, remote, track, cleanupPlayback } = call
    call.rtc = undefined
    call.room = undefined
    call.track = undefined
    call.remote = undefined
    call.cleanupPlayback = undefined
    cleanupPlayback?.()
    track?.close()
    remote?.stop()
    await Promise.allSettled([
      rtc?.leave(),
      room && fetch(prefix + '/stop', {
        method: 'POST', keepalive: true,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ connectionId: room.connectionId }),
      }),
    ])
  }

  function ensureCurrent(call: Call) {
    if (live.current !== call) throw new Error('The interview audio was closed.')
  }

  async function connect() {
    if (live.current) return
    const call: Call = { phase: 'ready' }
    live.current = call
    setConnection('joining'); setPhase('ready'); setBlocked(false); setError('')
    try {
      const sdk = await voiceRtc()
      ensureCurrent(call)
      const room = await request<VoiceRoom>(prefix + '/reserve', {}, token)
      call.room = room
      ensureCurrent(call)
      const rtc = sdk.createClient({ mode: 'rtc', codec: 'vp8' })
      call.rtc = rtc
      const autoplayFailed = () => { if (live.current === call) setBlocked(true) }
      sdk.on('autoplay-failed', autoplayFailed)
      call.cleanupPlayback = () => sdk.off('autoplay-failed', autoplayFailed)
      rtc.on('user-published', async (user, type) => {
        if (type !== 'audio' || String(user.uid) !== String(room.agentUid)) return
        try {
          const track = await rtc.subscribe(user, 'audio')
          if (live.current !== call) return
          call.remote = track
          track.setVolume(playbackPaused.current ? 0 : 100)
          track.play()
        } catch {
          if (live.current === call) setError('Could not play the interviewer’s audio.')
        }
      })
      await rtc.join(room.appId, room.channel, room.token, room.uid)
      ensureCurrent(call)
      await request(prefix + '/start', { connectionId: room.connectionId, guided: true }, token)
      await waitForInterviewer(rtc, room.agentUid)
      ensureCurrent(call)
      setConnection('connected')
    } catch (error) {
      const current = live.current === call
      await disconnect(call)
      if (current && !live.current) { setError((error as Error).message); setConnection('idle') }
    }
  }

  async function present(call: Call, question: string, repeat = false) {
    const key = question + ':' + topicVersion
    if (!call.room || (call.prompted === key && !repeat)) return
    call.prompted = key
    setPresenting(true); setError('')
    window.clearTimeout(promptTimer.current)
    try {
      await request(prefix + '/prompt', { connectionId: call.room.connectionId, topicId: question, topicVersion, repeat }, token)
      if (live.current === call && call.prompted === key) {
        promptTimer.current = window.setTimeout(() => setPresenting(false), 3200)
      }
    } catch (error) {
      if (live.current === call && call.prompted === key) {
        call.prompted = undefined
        setPresenting(false)
        setError((error as Error).message)
      }
    }
  }

  function playQuestion() {
    allowVoicePlayback()
    const call = live.current
    if (!call) { void connect(); return }
    setBlocked(false)
    if (topicId && announceTopic) void present(call, topicId, true)
  }

  async function capture(call: Call, stage: 'recording' | 'submitted' | 'cancelled', change?: ChangeOptions) {
    if (!call.room) return
    await request(prefix + '/capture', {
      connectionId: call.room.connectionId, phase: stage, topicId: call.topicId ?? null, topicVersion: call.topicVersion, change,
    }, token)
  }

  async function closeMic(call: Call) {
    const track = call.track
    call.track = undefined
    if (track) {
      track.getMediaStreamTrack().enabled = false
      try {
        await call.rtc?.unpublish(track)
      } finally {
        track.close()
      }
    }
  }

  async function begin(change?: ChangeOptions) {
    const call = live.current
    if (!call?.rtc || call.phase !== 'ready') return
    step(call, 'opening'); setError('')
    call.topicId = topicId
    call.topicVersion = topicVersion
    try {
      const sdk = await voiceRtc()
      ensureCurrent(call)
      const track = await sdk.createMicrophoneAudioTrack()
      if (live.current !== call) { track.close(); return }
      track.getMediaStreamTrack().enabled = false
      call.track = track
      await call.rtc.publish(track)
      await capture(call, 'recording', change)
      ensureCurrent(call)
      track.getMediaStreamTrack().enabled = true
      step(call, 'recording')
    } catch (error) {
      await closeMic(call).catch(() => undefined)
      await capture(call, 'cancelled').catch(() => undefined)
      if (live.current === call) {
        step(call, 'ready')
        setError((error as Error).message)
      }
    }
  }

  async function finish(call = live.current) {
    if (!call || call.phase !== 'recording' || !call.track) return
    call.track.getMediaStreamTrack().enabled = false
    step(call, 'submitting')
    try {
      await capture(call, 'submitted')
      ensureCurrent(call)
      step(call, 'waiting')
    } catch (error) {
      await capture(call, 'cancelled').catch(() => undefined)
      if (live.current === call) {
        step(call, 'ready')
        setError((error as Error).message)
      }
    } finally {
      await closeMic(call).catch(() => undefined)
    }
  }

  async function stop() {
    if (!live.current) return
    const call = live.current
    setConnection('leaving'); setPresenting(false); setSpeaking(false)
    window.clearTimeout(promptTimer.current)
    await disconnect(call)
    if (!live.current) { setConnection('idle'); setPhase('ready') }
  }

  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    let retry: number | undefined
    async function check() {
      const status = await request<{ available: boolean }>('/voice/status', undefined, undefined, controller.signal)
        .catch(() => ({ available: false }))
      if (controller.signal.aborted) return
      setAvailable(status.available)
      if (!status.available) retry = window.setTimeout(() => void check(), 4000)
    }
    void check()
    function pageHide() { if (live.current) void disconnect(live.current) }
    window.addEventListener('pagehide', pageHide)
    return () => {
      controller.abort()
      window.clearTimeout(retry)
      window.clearTimeout(promptTimer.current)
      window.removeEventListener('pagehide', pageHide)
      pageHide()
    }
  }, [enabled, sessionId, token])

  useEffect(() => {
    if (!enabled || !autoConnect || !available || autoAttempted.current) return
    autoAttempted.current = true
    void connect()
  }, [enabled, available, autoConnect])

  useEffect(() => {
    playbackPaused.current = paused
    live.current?.remote?.setVolume(paused ? 0 : 100)
    if (paused) setSpeaking(false)
  }, [paused])

  useEffect(() => {
    const call = live.current
    if (!enabled || connection !== 'connected' || !call) return
    if (call.phase !== 'ready' && call.topicVersion !== topicVersion) {
      void closeMic(call).catch(() => undefined)
      step(call, 'ready')
    }
    if (!paused && !blocked && topicId && announceTopic) void present(call, topicId)
  }, [enabled, connection, blocked, topicId, topicVersion, announceTopic, paused])

  useEffect(() => {
    const call = live.current
    const connectionId = call?.room?.connectionId
    if (!enabled || connection !== 'connected' || !connectionId) return
    const controller = new AbortController()
    let timer: number
    async function watch() {
      try {
        const status = await request<{ active: boolean }>(prefix + '/watch',
          { connectionId }, token, controller.signal)
        if (controller.signal.aborted) return
        if (!status.active) { await stop(); return }
      } catch {
        if (controller.signal.aborted) return
      }
      timer = window.setTimeout(() => void watch(), 4000)
    }
    timer = window.setTimeout(() => void watch(), 4000)
    return () => { controller.abort(); window.clearTimeout(timer) }
  }, [enabled, connection, prefix, token])

  useEffect(() => {
    const call = live.current
    if (!enabled || paused || connection !== 'connected' || !call) return
    let lastSpeech = -Infinity
    let remoteWasSpeaking = false
    const levels = window.setInterval(() => {
      if (live.current !== call) return
      const remote = call.remote?.getVolumeLevel() ?? 0
      const mic = call.phase === 'recording' ? call.track?.getVolumeLevel() ?? 0 : 0
      const now = performance.now()
      if (remote > 0.03) lastSpeech = now
      const remoteSpeaking = now - lastSpeech < 850
      meter.current?.style.setProperty('--voice-level', String(Math.min(1, Math.max(remote, mic) * 2.8)))
      if (remoteSpeaking !== remoteWasSpeaking) {
        setSpeaking(remoteSpeaking)
        if (remoteSpeaking) {
          setPresenting(false)
          if (call.phase === 'recording') void finish(call)
        } else if (call.phase === 'waiting') {
          step(call, 'ready')
        }
        remoteWasSpeaking = remoteSpeaking
      }
    }, 55)
    return () => { window.clearInterval(levels); meter.current?.style.removeProperty('--voice-level') }
  }, [enabled, connection, paused])

  useEffect(() => {
    if (phase !== 'waiting') return
    const call = live.current
    const timeout = window.setTimeout(() => {
      if (call && live.current === call && call.phase === 'waiting') step(call, 'ready')
    }, 28000)
    return () => window.clearTimeout(timeout)
  }, [phase])

  const status = paused ? 'Audio paused' : !enabled ? 'Interview complete' : available === null ? 'Checking audio'
    : !available ? 'Audio unavailable' : connection === 'joining' ? 'Connecting audio'
    : connection === 'leaving' ? 'Closing audio'
    : connection !== 'connected' || blocked ? 'Audio paused'
    : phase === 'recording' ? 'Listening to you' : speaking ? 'Speaking' : presenting ? 'Preparing question'
    : phase === 'opening' ? 'Opening microphone' : phase === 'submitting' || phase === 'waiting' ? 'Processing answer'
    : 'Paused for you'

  return {
    meter, enabled, available, connection, phase, speaking, presenting, blocked, error, status,
    busy: ['opening', 'recording', 'submitting'].includes(phase) || presenting,
    playQuestion, begin, finish, stop,
  }
}

type Voice = ReturnType<typeof useInterviewVoice>

export function VoicePresence({ voice, interview }: { voice: Voice; interview: boolean }) {
  const activity = voice.phase === 'recording' ? 'participant'
    : voice.speaking ? 'interviewer'
    : voice.connection === 'joining' || voice.presenting || voice.phase === 'waiting' ? 'working' : 'paused'
  return <section className="voice-presence" aria-label="Voice session">
    <div className="voice-profile">
      <div ref={voice.meter} className="voice-orb" data-activity={activity} aria-hidden="true">
        <span className="voice-orb-halo"/>
        <span className="voice-orb-core"><AudioLines size={27}/></span>
      </div>
      <div className="voice-identity">
        <strong>{interview ? 'Interviewer' : 'Lineage assistant'}</strong>
        <span role="status">{voice.status}</span>
      </div>
    </div>
    {voice.enabled && voice.connection === 'connected' && <Button type="button" variant="ghost" size="sm" className="voice-leave"
      onClick={() => void voice.stop()}><PhoneOff aria-hidden="true"/> End audio</Button>}
  </section>
}

export function VoiceControls({ voice, interview, question, correction, change, busy }: {
  voice: Voice
  interview: boolean
  question: boolean
  correction: boolean
  change?: ChangeOptions
  busy: boolean
}) {
  const recording = voice.phase === 'recording'
  const needsPlayback = voice.blocked || voice.connection === 'idle'
  const waiting = voice.connection === 'joining' || voice.connection === 'leaving' || voice.presenting
    || voice.phase === 'opening' || voice.phase === 'submitting' || voice.phase === 'waiting'
  const label = waiting ? voice.status : needsPlayback ? (question ? 'Play question' : 'Connect audio')
    : recording ? (interview ? 'Finish answer' : 'Finish question')
    : correction ? 'Record a correction' : interview ? 'Answer question' : 'Ask a question'
  return <div className="voice-answer">
    <Button type="button" size="lg" className="voice-mic" data-recording={recording}
      disabled={busy || !voice.available || waiting || (voice.speaking && !recording && !needsPlayback)}
      onClick={() => needsPlayback ? voice.playQuestion() : recording ? void voice.finish() : void voice.begin(change)}>
      <span className="voice-mic-icon">
        {waiting ? <LoaderCircle className="spin" aria-hidden="true"/>
          : needsPlayback ? <Volume2 aria-hidden="true"/> : recording ? <Square aria-hidden="true"/> : <Mic aria-hidden="true"/>}
      </span>
      {label}
    </Button>
    {question && !needsPlayback && !recording && <Button type="button" variant="ghost" size="sm"
      disabled={busy || waiting || voice.speaking} onClick={voice.playQuestion}>
      <RotateCcw aria-hidden="true"/> Repeat question
    </Button>}
    {voice.error && <p className="voice-error" role="alert">{voice.error}</p>}
  </div>
}
