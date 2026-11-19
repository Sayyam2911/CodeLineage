import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { ArrowDownRight, ArrowRight, BookOpen, ChevronDown, CircleAlert, GitFork, Github, LoaderCircle } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RepositoryExample } from './RepositoryExample'
import { request, sleep } from './api'
import type { Mode, Scan, Session } from './api'

const demoRepository = 'https://github.com/healthchecks/healthchecks'
const scanLabels = {
  queued: 'Scan queued…',
  scanning: 'Capturing source and extracting structure…',
  analyzing: 'Reviewing the evidence…',
}

export function Launchpad({ onOpen }: { onOpen: (session: Session) => void }) {
  const [url, setUrl] = useState('')
  const [ref, setRef] = useState('')
  const [scope, setScope] = useState('')
  const [speaker, setSpeaker] = useState('')
  const [busy, setBusy] = useState<Mode | null>(null)
  const [progress, setProgress] = useState('')
  const [error, setError] = useState('')
  const [invalidUrl, setInvalidUrl] = useState(false)
  const [options, setOptions] = useState(false)
  const field = useRef<HTMLInputElement>(null)
  const intake = useRef<AbortController | null>(null)

  useEffect(() => () => intake.current?.abort(), [])

  function useDemo() {
    setUrl(demoRepository)
    setError('')
    setInvalidUrl(false)
    field.current?.focus()
  }

  async function open(nextMode: Mode) {
    if (busy) return
    setError('')
    setInvalidUrl(false)
    const repository = url.trim()
    if (!repository) {
      setError('Enter a public GitHub repository URL or use the Healthchecks example.')
      setInvalidUrl(true)
      field.current?.focus()
      return
    }
    intake.current?.abort()
    const active = new AbortController()
    intake.current = active
    setBusy(nextMode)
    try {
      let snapshotId: string | undefined
      if (nextMode === 'update') {
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
        url: repository, mode: nextMode, snapshotId, speaker: speaker.trim() || 'Interview participant',
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
        setBusy(null)
      }
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const button = (event.nativeEvent as SubmitEvent).submitter
    void open(button instanceof HTMLButtonElement && button.value === 'understand' ? 'understand' : 'update')
  }

  function cancel() {
    intake.current?.abort()
    setBusy(null)
    setProgress('')
  }

  return (
    <main id="main-content" className="launchpad">
      <div className="launch-intro">
        <h1>Understand the decisions <span>behind your code.</span></h1>
        <p>Open a GitHub repository, trace the architecture to its source, and record the reasons it works that way.</p>

        <form className="repo-form" onSubmit={submit} noValidate aria-busy={!!busy}>
          <div className="repo-form-heading">
            <Label htmlFor="repository">Public GitHub repository</Label>
            <Button type="button" variant="ghost" size="sm" className="repo-demo-button" disabled={!!busy} onClick={useDemo}>
              Use the Healthchecks demo <ArrowDownRight aria-hidden="true"/>
            </Button>
          </div>
          <div className="repo-input">
            <Github aria-hidden="true" size={18}/>
            <Input
              ref={field}
              id="repository"
              name="repository"
              type="url"
              placeholder="https://github.com/owner/repository…"
              autoComplete="off"
              spellCheck={false}
              value={url}
              aria-invalid={invalidUrl}
              aria-describedby={invalidUrl ? 'repository-error' : undefined}
              disabled={!!busy}
              onChange={event => { setUrl(event.target.value); setInvalidUrl(false); setError('') }}
            />
          </div>
          {error && (
            <Alert id="repository-error" variant="destructive" className="inline-notice">
              <CircleAlert aria-hidden="true"/>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <Collapsible open={options} onOpenChange={setOptions}>
            <CollapsibleTrigger asChild>
              <Button type="button" variant="ghost" size="sm" className="options-trigger" disabled={!!busy}>
                <ChevronDown aria-hidden="true"/>
                Review options
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="repo-options">
              <div><Label htmlFor="repository-ref">Branch, tag or SHA</Label>
                <Input id="repository-ref" name="ref" autoComplete="off" spellCheck={false} value={ref} disabled={!!busy} placeholder="Default branch…" onChange={event => setRef(event.target.value)}/>
              </div>
              <div><Label htmlFor="repository-scope">Directory scope</Label>
                <Input id="repository-scope" name="scope" autoComplete="off" spellCheck={false} value={scope} disabled={!!busy} placeholder="Entire repository…" onChange={event => setScope(event.target.value)}/>
              </div>
              <div><Label htmlFor="repository-speaker">Display name</Label>
                <Input id="repository-speaker" name="speaker" autoComplete="name" value={speaker} disabled={!!busy} placeholder="Interview participant…" onChange={event => setSpeaker(event.target.value)}/>
              </div>
            </CollapsibleContent>
          </Collapsible>

          <div className="repo-actions">
            <Button type="submit" name="mode" value="update" disabled={!!busy}>
              {busy === 'update' ? <LoaderCircle className="animate-spin" aria-hidden="true"/> : <GitFork aria-hidden="true"/>}
              Create or update code lineage
              <ArrowRight className="repo-action-arrow" aria-hidden="true"/>
            </Button>
            <Button type="submit" name="mode" value="understand" variant="outline" disabled={!!busy}>
              {busy === 'understand' ? <LoaderCircle className="animate-spin" aria-hidden="true"/> : <BookOpen aria-hidden="true"/>}
              Understand code lineage
              <ArrowRight className="repo-action-arrow" aria-hidden="true"/>
            </Button>
          </div>
          {busy && (
            <div className="repo-progress" role="status">
              <span>{progress}</span>
              <Button type="button" size="sm" variant="ghost" onClick={cancel}>Cancel</Button>
            </div>
          )}
        </form>
      </div>

      <RepositoryExample/>
    </main>
  )
}
