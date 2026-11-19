import { useEffect, useRef, useState } from 'react'
import type { IAgoraRTCClient, IMicrophoneAudioTrack } from 'agora-rtc-sdk-ng'
import { LoaderCircle, Mic, PhoneOff } from 'lucide-react'
import { request } from './api'

type Join = { appId: string; token: string; channel: string; uid: number; connectionId: string }

export function Voice({ sessionId, token, disabled }: { sessionId: string; token: string; disabled: boolean }) {
  const [available, setAvailable] = useState<boolean | null>(null)
  const [state, setState] = useState<'idle' | 'starting' | 'active' | 'stopping'>('idle')
  const [error, setError] = useState('')
  const joined = useRef<{ rtc?: IAgoraRTCClient; track?: IMicrophoneAudioTrack; info?: Join }>({})
  const mounted = useRef(true)
  const prefix = '/voice/sessions/' + sessionId

  async function release() {
    const { rtc, track, info } = joined.current
    joined.current = {}
    track?.close()
    const results = await Promise.allSettled([
      rtc?.leave(),
      info ? request(prefix + '/stop', { connectionId: info.connectionId }, token) : undefined,
    ])
    const problem = results.find(result => result.status === 'rejected')
    if (problem?.status === 'rejected') throw problem.reason
  }

  useEffect(() => {
    mounted.current = true
    void request<{ available: boolean }>('/voice/status').then(
      config => { if (mounted.current) setAvailable(config.available) },
      () => { if (mounted.current) setAvailable(false) },
    )
    return () => { mounted.current = false; void release().catch(() => undefined) }
  }, [sessionId])

  useEffect(() => {
    if (disabled) void release().catch(() => undefined)
  }, [disabled])

  async function start() {
    setState('starting'); setError('')
    try {
      const { default: AgoraRTC } = await import('agora-rtc-sdk-ng')
      const info = await request<Join>(prefix + '/reserve', {}, token)
      const rtc = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' })
      joined.current = { rtc, info }
      if (!mounted.current) throw new Error('Voice session closed.')
      rtc.on('user-published', async (user, type) => {
        if (type !== 'audio') return
        try {
          await rtc.subscribe(user, type)
          user.audioTrack?.play()
        } catch {
          if (mounted.current) setError('Could not play the agent’s audio.')
        }
      })
      await rtc.join(info.appId, info.channel, info.token, info.uid)
      const track = await AgoraRTC.createMicrophoneAudioTrack()
      if (!mounted.current || joined.current.info?.connectionId !== info.connectionId) {
        track.close()
        throw new Error('Voice session closed.')
      }
      joined.current.track = track
      await rtc.publish(track)
      await request(prefix + '/start', { connectionId: info.connectionId }, token)
      if (mounted.current) setState('active')
    } catch (reason) {
      await release().catch(() => undefined)
      if (mounted.current) { setError((reason as Error).message); setState('idle') }
    }
  }

  async function stop() {
    setState('stopping'); setError('')
    try {
      await release()
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      if (mounted.current) setState('idle')
    }
  }

  if (disabled || available === null) return null
  if (!available) return <p className="voice-status"><Mic size={15}/> Voice unavailable. You can continue in text.</p>
  return <div className="voice-controls">
    {state === 'idle' ? <button className="quiet" onClick={() => void start()}><Mic size={16}/> Start voice</button>
      : state === 'active' ? <button className="quiet" onClick={() => void stop()}><PhoneOff size={16}/> End voice</button>
      : <span className="voice-status"><LoaderCircle size={15} className="spin"/>{state === 'starting' ? 'Connecting voice…' : 'Closing voice…'}</span>}
    {state === 'active' && <span className="voice-status" role="status">Microphone live</span>}
    {error && <span className="voice-error" role="alert">{error}</span>}
  </div>
}
