'use client'

import { useEffect, useState } from 'react'
import { CircleAlert, Layers3, LoaderCircle } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Launchpad } from './Launchpad'
import { Workspace } from './Workspace'
import { ApiError, request } from './api'
import type { Session } from './api'

const storageKey = 'codelineage-session'
type SessionKey = Pick<Session, 'id' | 'token'>

export default function CodeLineageApp() {
  const [session, setSession] = useState<Session | null>(null)
  const [resumeError, setResumeError] = useState('')
  const [restoring, setRestoring] = useState(false)

  useEffect(() => { if (sessionStorage.getItem(storageKey)) setRestoring(true) }, [])

  useEffect(() => {
    if (!restoring) return
    const saved = sessionStorage.getItem(storageKey)
    if (!saved) { setRestoring(false); return }
    const controller = new AbortController()
    try {
      const key = JSON.parse(saved) as SessionKey
      void request<Session>('/sessions/' + key.id, undefined, key.token, controller.signal).then(
        result => { if (!controller.signal.aborted) setSession({ ...result, token: key.token }) },
        reason => {
          if (controller.signal.aborted) return
          if (reason instanceof ApiError && [401, 404].includes(reason.status)) sessionStorage.removeItem(storageKey)
          else setResumeError('The saved review could not be reached.')
        },
      ).finally(() => { if (!controller.signal.aborted) setRestoring(false) })
    } catch {
      sessionStorage.removeItem(storageKey)
      setRestoring(false)
    }
    return () => controller.abort()
  }, [restoring])

  function exit() {
    sessionStorage.removeItem(storageKey)
    setSession(null)
    setRestoring(false)
    setResumeError('')
  }

  return (
    <TooltipProvider delayDuration={200}>
      <a href="#main-content" className="skip-link">Skip to content</a>
      <header className="topbar">
        <Button type="button" variant="ghost" className="brand" onClick={exit} aria-label="CodeLineage home">
          <span className="brand-mark"><Layers3 aria-hidden="true"/></span>
          <span translate="no">CodeLineage</span>
        </Button>
      </header>
      {restoring
        ? <main id="main-content" className="resume" role="status">
            <LoaderCircle className="animate-spin" size={19} aria-hidden="true"/> Restoring review…
          </main>
        : resumeError
          ? <main id="main-content" className="resume resume-error">
              <Alert variant="destructive" className="inline-notice">
                <CircleAlert aria-hidden="true"/><AlertDescription>{resumeError}</AlertDescription>
              </Alert>
              <div className="controls">
                <Button onClick={() => { setResumeError(''); setRestoring(true) }}>Retry review</Button>
                <Button variant="ghost" onClick={exit}>Home</Button>
              </div>
            </main>
          : session
            ? <Workspace key={session.id} initial={session} onExit={exit}/>
            : <Launchpad onOpen={next => {
                sessionStorage.setItem(storageKey, JSON.stringify({ id: next.id, token: next.token } satisfies SessionKey))
                setSession(next)
              }}/>}
    </TooltipProvider>
  )
}
