import { useEffect, useRef, useState } from 'react'
import type { FormEvent, MouseEvent } from 'react'
import { ArrowRight, BookOpen, ChevronDown, CircleAlert, GitBranch, Github, LoaderCircle } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RepositoryExample } from './RepositoryExample'
import { request, sleep } from './api'
import type { Mode, Scan, Session } from './api'

const demoRepository = 'https://github.com/healthchecks/healthchecks'
const modeLabels = { update: 'Create or update code lineage', understand: 'Understand code lineage' }
const scanLabels = {
  queued: 'Scan queued…',
  scanning: 'Capturing source and extracting structure…',
  analyzing: 'Reviewing the evidence…',
}

export function Launchpad({ onOpen }: { onOpen: (session: Session) => void }) {
  const [mode, setMode] = useState<Mode | null>(null)
  const [url, setUrl] = useState('')
  const [ref, setRef] = useState('')
  const [scope, setScope] = useState('')
  const [speaker, setSpeaker] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [error, setError] = useState('')
  const [invalidUrl, setInvalidUrl] = useState(false)
  const field = useRef<HTMLInputElement>(null)
  const title = useRef<HTMLHeadingElement>(null)
  const launcher = useRef<HTMLButtonElement>(null)
  const intake = useRef<AbortController | null>(null)

  useEffect(() => () => intake.current?.abort(), [])

  function resetError() {
    setError('')
    setInvalidUrl(false)
  }

  function begin(nextMode: Mode, event: MouseEvent<HTMLButtonElement>) {
    launcher.current = event.currentTarget
    resetError()
    setMode(nextMode)
  }

  function close() {
    intake.current?.abort()
    setBusy(false)
    setProgress('')
    setMode(null)
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!mode || busy) return
    resetError()
    const repository = url.trim()
    if (!repository) {
      setError('Enter a public GitHub repository URL or use the Healthchecks demo.')
      setInvalidUrl(true)
      field.current?.focus()
      return
    }
    const active = new AbortController()
    intake.current = active
    setBusy(true)
    try {
      let snapshotId: string | undefined
      if (mode === 'update') {
        setProgress('Resolving the GitHub commit…')
        let scan = await request<Scan>('/scans', {
          url: repository, ref: ref.trim() || null, scope: scope.trim() || null,
        }, undefined, active.signal)
        while (scan.status === 'queued' || scan.status === 'scanning' || scan.status === 'analyzing') {
          setProgress(scanLabels[scan.status])
          await sleep(850)
          scan = await request<Scan>('/scans/' + scan.id, undefined, undefined, active.signal)
        }
        if (scan.status === 'failed' || !scan.snapshotId) throw new Error(scan.error ?? 'No snapshot was produced.')
        snapshotId = scan.snapshotId
        setProgress(scan.reused ? 'Opening the saved scan…' : 'Opening the review…')
      } else {
        setProgress('Finding the reviewed lineage…')
      }
      const session = await request<Session>('/sessions', {
        url: repository, mode, snapshotId, speaker: speaker.trim() || 'Interview participant',
      }, undefined, active.signal)
      if (!active.signal.aborted) onOpen(session)
    } catch (reason) {
      if (!active.signal.aborted) {
        const message = (reason as Error).message
        setError(message)
        setInvalidUrl(/public GitHub repository URL/i.test(message))
      }
    } finally {
      if (!active.signal.aborted) {
        setProgress('')
        setBusy(false)
      }
    }
  }

  return (
    <main id="main-content" tabIndex={-1} className="launchpad">
      <Dialog open={mode !== null} onOpenChange={open => { if (!open) close() }}>
        <section className="launch-hero" aria-labelledby="launch-heading">
          <div className="hero-field" aria-hidden="true"/>
          <div className="hero-grid" aria-hidden="true"/>
          <div className="hero-content">
            <h1 id="launch-heading">Trace the decisions <span>behind the code.</span></h1>
            <p>Map a GitHub repository to its source and record the reasoning behind its architecture.</p>
            <div className="repo-actions">
              <Button type="button" size="lg" onClick={event => begin('update', event)}>
                <GitBranch aria-hidden="true"/> {modeLabels.update}
              </Button>
              <Button type="button" variant="outline" size="lg" onClick={event => begin('understand', event)}>
                {modeLabels.understand} <ArrowRight aria-hidden="true"/>
              </Button>
            </div>
          </div>
        </section>

        {mode && <DialogContent className="intake-dialog" onOpenAutoFocus={event => {
          event.preventDefault()
          if (matchMedia('(pointer: fine)').matches) field.current?.focus()
          else title.current?.focus()
        }} onCloseAutoFocus={event => {
          event.preventDefault()
          launcher.current?.focus()
        }}>
          <DialogHeader>
            <div className="intake-icon">{mode === 'update' ? <GitBranch aria-hidden="true"/> : <BookOpen aria-hidden="true"/>}</div>
            <DialogTitle ref={title} tabIndex={-1}>{modeLabels[mode]}</DialogTitle>
            <DialogDescription>{mode === 'update'
              ? 'Choose a repository to open a source-backed review.'
              : 'Open a reviewed repository to explore its architecture and ask questions.'}</DialogDescription>
          </DialogHeader>
          <form className="repo-form" onSubmit={submit} noValidate aria-busy={busy}>
            <div className="repo-form-heading">
              <Label htmlFor="repository">Public GitHub repository</Label>
              <Button type="button" variant="ghost" size="sm" className="repo-demo-button" disabled={busy} onClick={() => {
                setUrl(demoRepository)
                resetError()
                field.current?.focus()
              }}>Use the Healthchecks demo</Button>
            </div>
            <div className="repo-input">
              <Github aria-hidden="true" size={17}/>
              <Input ref={field} id="repository" name="repository" type="url" autoComplete="off" spellCheck={false}
                placeholder="https://github.com/owner/repository…" value={url} disabled={busy}
                aria-invalid={invalidUrl} aria-describedby={invalidUrl ? 'repository-error' : undefined}
                onChange={event => { setUrl(event.target.value); resetError() }}/>
            </div>
            {error && <Alert id="repository-error" variant="destructive" className="inline-notice">
              <CircleAlert aria-hidden="true"/><AlertDescription>{error}</AlertDescription>
            </Alert>}
            {mode === 'update' && <Collapsible>
              <CollapsibleTrigger asChild>
                <Button type="button" variant="ghost" size="sm" className="options-trigger" disabled={busy}>
                  <ChevronDown aria-hidden="true"/> Review options
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="repo-options">
                <div><Label htmlFor="repository-ref">Branch, tag or SHA</Label>
                  <Input id="repository-ref" name="ref" autoComplete="off" spellCheck={false} value={ref} disabled={busy}
                    placeholder="Default branch…" onChange={event => setRef(event.target.value)}/>
                </div>
                <div><Label htmlFor="repository-scope">Directory scope</Label>
                  <Input id="repository-scope" name="scope" autoComplete="off" spellCheck={false} value={scope} disabled={busy}
                    placeholder="Entire repository…" onChange={event => setScope(event.target.value)}/>
                </div>
                <div><Label htmlFor="repository-speaker">Display name</Label>
                  <Input id="repository-speaker" name="speaker" autoComplete="name" value={speaker} disabled={busy}
                    placeholder="Interview participant…" onChange={event => setSpeaker(event.target.value)}/>
                </div>
              </CollapsibleContent>
            </Collapsible>}
            <div className="intake-actions">
              <Button type="button" variant="outline" onClick={close}>{busy ? 'Close' : 'Cancel'}</Button>
              <Button type="submit" disabled={busy}>
                {busy ? <LoaderCircle className="animate-spin" aria-hidden="true"/> : <ArrowRight aria-hidden="true"/>}
                {mode === 'update' ? 'Open review' : 'Open lineage'}
              </Button>
            </div>
            {busy && <p className="repo-progress" role="status">{progress}</p>}
          </form>
        </DialogContent>}
      </Dialog>
      <RepositoryExample/>
    </main>
  )
}
