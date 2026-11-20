import type { IAgoraRTC, IAgoraRTCClient } from 'agora-rtc-sdk-ng'

export type VoiceRoom = {
  appId: string
  token: string
  channel: string
  uid: number
  agentUid: number
  connectionId: string
}

let sdk: IAgoraRTC | undefined

export async function voiceRtc() {
  return sdk ?? (sdk = (await import('agora-rtc-sdk-ng')).default)
}

export function allowVoicePlayback() {
  if (sdk) sdk.resumeAudioContext()
  else void voiceRtc().then(client => client.resumeAudioContext()).catch(() => undefined)
}

export function waitForInterviewer(rtc: IAgoraRTCClient, agentUid: number) {
  if (rtc.remoteUsers.some(user => String(user.uid) === String(agentUid))) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      rtc.off('user-joined', joined)
      reject(new Error('The interviewer could not join. Try connecting again.'))
    }, 12000)
    function joined(user: { uid: string | number }) {
      if (String(user.uid) !== String(agentUid)) return
      window.clearTimeout(timeout)
      rtc.off('user-joined', joined)
      resolve()
    }
    rtc.on('user-joined', joined)
  })
}
