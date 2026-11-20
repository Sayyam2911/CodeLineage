import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import {
  ArrowLeft, ArrowRight, ArrowUpRight, AudioLines, Check, ChevronDown, CircleAlert,
  Code2, FileCode2, GitCommitHorizontal, GitFork, Github, LoaderCircle, PanelRight, Search, Settings2, SquareTerminal,
} from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { decisionEvidence } from '@/lib/architecture'
import { allowVoicePlayback } from '@/lib/voice-media'
import { Diagram } from './Diagram'
import { ClaimEntry, Coverage, EvidenceLinks, PriorReview, ReviewTopics } from './Review'
import { SourceExcerpt } from './SourceExcerpt'
import { useInterviewVoice, VoiceControls, VoicePresence } from './Voice'
import { query, request } from './api'
import type { Analysis, ChangeOptions, Claim, Edge, Evidence, Excerpt, Graph, Manifest, Node, Review, Revision, Session, SessionEvent, Topic, Turn } from './api'

type Operation = ChangeOptions['operation']

function activeReceipt(session: Session) {
  const saved = session.latestReceipt
  return saved && !session.pending && !session.finished && (saved.topicVersion ?? 0) === (session.topicVersion ?? 0) ? saved : null
}

export function Workspace({ initial, autoConnect, onExit }: { initial: Session; autoConnect: boolean; onExit: () => void }) {
  const [session, setSession] = useState(initial)
  const [graph, setGraph] = useState<Graph | null>(null)
  const [manifest, setManifest] = useState<Manifest | null>(null)
  const [analysis, setAnalysis] = useState<Analysis | null>(null)
  const [review, setReview] = useState<Review | null>(null)
  const [turns, setTurns] = useState<Turn[]>([])
  const [activeEdge, setActiveEdge] = useState<Edge | null>(null)
  const [connectionIssue, setConnectionIssue] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [excerpt, setExcerpt] = useState<Excerpt | null>(null)
  const [evidenceNote, setEvidenceNote] = useState<Evidence | Claim | null>(null)
  const [sourceError, setSourceError] = useState('')
  const [sourceLoading, setSourceLoading] = useState(false)
  const [sourceSnapshot, setSourceSnapshot] = useState(initial.snapshotId)
  const latestEvidence = useRef<{ ref: Evidence; followConfig: boolean } | null>(null)
  const sourceRequest = useRef<AbortController | null>(null)
  const [anchor, setAnchor] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [decisionId, setDecisionId] = useState<string | null>(null)
  const [file, setFile] = useState('')
  const [first, setFirst] = useState(1)
  const [last, setLast] = useState<number | ''>('')
  const [operation, setOperation] = useState<Operation>('annotate')
  const [changeLabel, setChangeLabel] = useState('')
  const [related, setRelated] = useState('')
  const [scopes, setScopes] = useState('')
  const [supersedes, setSupersedes] = useState('')
  const [exceptionTo, setExceptionTo] = useState('')
  const [historyTopic, setHistoryTopic] = useState<Topic | null>(null)
  const [connectAfterSelection, setConnectAfterSelection] = useState(false)
  const appliedRevision = useRef(initial.latestReceipt?.revision ?? 0)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [applying, setApplying] = useState(false)
  const seq = useRef(initial.seq)
  const shownRevision = useRef(initial.revision)
  const shownTopicVersion = useRef(initial.topicVersion ?? 0)
  const sourceSequence = useRef(0)
  const heading = useRef<HTMLHeadingElement>(null)
  const architecture = useRef<HTMLElement>(null)
  const path = '/sessions/' + session.id
  const snapshot = '/snapshots/' + session.snapshotId
  const topic = session.topics[session.index]
  const topicVersion = session.topicVersion ?? 0
  const receipt = activeReceipt(session)
  const interview = session.mode === 'update'
  const topicSource = topic?.evidence.find(item => item.kind === 'source')
  const activeQuestion = interview && !session.finished && !receipt && !historyTopic ? topic : undefined
  const displayedQuestion = historyTopic ?? activeQuestion
  const displayedIndex = historyTopic ? session.topics.findIndex(item => item.id === historyTopic.id) : session.index
  const decision = graph?.claims.find(claim => claim.claimId === decisionId)
  const voice = useInterviewVoice({
    sessionId: session.id, token: session.token, enabled: !session.finished && (!interview || !!session.topics.length),
    autoConnect: autoConnect || connectAfterSelection, topicVersion, paused: !!historyTopic,
    topicId: activeQuestion?.id, announceTopic: !!activeQuestion && !session.pending,
  })
  const working = !!busy || voice.busy
  const switchingDisabled = !!busy || applying || voice.presenting || voice.phase !== 'ready'
  const change: ChangeOptions | undefined = activeQuestion ? {
    operation, scope: scopes.trim() ? scopes.split(',').map(value => value.trim()).filter(Boolean) : null,
    targetId: selected, relatedId: related || null, label: changeLabel.trim() || null,
    supersedes: supersedes || null, exceptionTo: exceptionTo || null,
  } : undefined

  useEffect(() => {
    window.scrollTo(0, 0)
    heading.current?.focus({ preventScroll: true })
  }, [])

  async function showEvidence(ref: Evidence, followConfig = false) {
    sourceRequest.current?.abort()
    const controller = new AbortController()
    sourceRequest.current = controller
    const requestId = ++sourceSequence.current
    latestEvidence.current = { ref, followConfig }
    setSourceError('')
    setExcerpt(null)
    setEvidenceNote(ref.kind !== 'source' ? ref : null)
    if (ref.kind !== 'source' || !ref.path || !ref.start) {
      setSourceLoading(false)
      return
    }
    const evidenceSnapshot = ref.snapshotId ?? session.snapshotId
    setSourceSnapshot(evidenceSnapshot)
    setFile(ref.path); setFirst(ref.start); setLast(ref.end ?? '')
    setSourceLoading(true)
    try {
      const data = await request<Excerpt>(query('/snapshots/' + evidenceSnapshot + '/source', {
        path: ref.path, start: ref.start, ...(ref.end ? { end: ref.end } : {}),
        ...(ref.end ? { context: 7 } : {}), ...(followConfig ? { follow_config: true } : {}),
      }), undefined, undefined, controller.signal)
      if (requestId === sourceSequence.current) {
        const displayed = data.implementation ?? data
        setExcerpt(displayed)
        if (data.implementation) {
          setFile(displayed.path); setFirst(displayed.highlight.start); setLast(displayed.highlight.end)
        }
      }
    } catch (reason) {
      if (!controller.signal.aborted && requestId === sourceSequence.current) setSourceError((reason as Error).message)
    } finally {
      if (!controller.signal.aborted && requestId === sourceSequence.current) setSourceLoading(false)
    }
  }

  function includeTurn(item: Turn) {
    setTurns(previous => previous.some(turn => turn.id === item.id) ? previous
      : [...previous, item].sort((left, right) => left.seq - right.seq))
  }

  async function loadTurns(signal?: AbortSignal) {
    const persisted = await request<Turn[]>(path + '/turns', undefined, initial.token, signal)
    setTurns(previous => [...new Map([...previous, ...persisted].map(item => [item.id, item])).values()]
      .sort((left, right) => left.seq - right.seq))
  }

  function showTopicEvidence(active: Topic, ref: Evidence, followConfig = true) {
    setDecisionId(null)
    setAnchor(active.targetId); setSelected(active.targetId); setActiveEdge(null)
    void showEvidence(ref, followConfig)
  }

  function focusTopic(active: Topic | undefined) {
    if (!active) return
    setOperation('annotate'); setChangeLabel(''); setRelated(''); setScopes(''); setSupersedes(''); setExceptionTo('')
    const ref = active.evidence.find(item => item.kind === 'source') ?? active.evidence[0]
    if (ref) showTopicEvidence(active, ref)
    else setDecisionId(null)
  }

  useEffect(() => {
    if (shownTopicVersion.current === topicVersion) return
    shownTopicVersion.current = topicVersion
    setHistoryTopic(null)
    if (!receipt) focusTopic(topic)
  }, [topicVersion])

  function inspectDecision(claim: Claim) {
    sourceRequest.current?.abort()
    sourceSequence.current += 1
    setSourceLoading(false); setSourceError(''); setEvidenceNote(claim); setActiveEdge(null)
  }

  async function focusDecision(claim: Claim) {
    setDecisionId(claim.claimId)
    const target = claim.snapshotId === session.snapshotId ? claim.targetId : null
    setAnchor(target); setSelected(target); setActiveEdge(null)
    const ref = decisionEvidence(claim)
    if (ref) await showEvidence(ref)
    else inspectDecision(claim)
  }

  async function loadGraph(revision: number) {
    const data = await request<Graph>(query(snapshot + '/graph', { revision }))
    if (revision >= shownRevision.current) {
      shownRevision.current = revision
      setGraph(data)
    }
  }

  async function refresh(advanceCursor = false) {
    const state = await request<Session>(path, undefined, initial.token)
    const next = { ...state, token: initial.token }
    if (advanceCursor) seq.current = Math.max(seq.current, next.seq)
    setSession(previous => previous.seq > next.seq ? previous : next)
    return next
  }

  async function applied(change: Revision) {
    if (change.revision <= appliedRevision.current) return
    appliedRevision.current = change.revision
    setOperation('annotate'); setChangeLabel(''); setRelated(''); setScopes(''); setSupersedes(''); setExceptionTo('')
    setApplying(true)
    try {
      const [state] = await Promise.all([refresh(), loadGraph(change.revision), loadTurns()])
      if (activeReceipt(state)?.revision === change.revision) {
        await focusDecision(change.claim)
        architecture.current?.scrollIntoView({ block: 'nearest' })
      }
    } catch (reason) {
      setError('Revision saved. Refresh failed: ' + (reason as Error).message)
    } finally {
      setApplying(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    const abort = new AbortController()
    let timer: number | undefined
    void Promise.all([loadGraph(initial.revision), request<Manifest>(snapshot).then(value => {
      if (!cancelled) setManifest(value)
    })]).catch(reason => { if (!cancelled) setError((reason as Error).message) })
    void request<Analysis>(snapshot + '/findings', undefined, undefined, abort.signal)
      .then(setAnalysis).catch(() => undefined)
    if (interview) void request<Review>(snapshot + '/review', undefined, undefined, abort.signal)
      .then(setReview).catch(reason => { if (!cancelled) setError((reason as Error).message) })
    void loadTurns(abort.signal).catch(() => undefined)
    const saved = initial.finished ? initial.latestReceipt : activeReceipt(initial)
    if (saved) void focusDecision(saved.claim)
    else if (initial.evidenceFocus) void showEvidence(initial.evidenceFocus)
    else focusTopic(initial.topics[initial.index])

    async function synchronize() {
      const state = await refresh(true)
      if (state.latestReceipt && state.latestReceipt.revision > appliedRevision.current) await applied(state.latestReceipt)
      else {
        if (state.revision > shownRevision.current) await loadGraph(state.revision)
        if (state.evidenceFocus) await showEvidence(state.evidenceFocus)
      }
      await loadTurns(abort.signal)
      setApplying(false)
    }

    async function consume() {
      try {
        const response = await fetch(query(path + '/events', { after: seq.current, wait: true }), {
          headers: { Authorization: 'Bearer ' + initial.token }, signal: abort.signal,
        })
        if (!response.ok || !response.body) throw new Error('Session update stream unavailable.')
        setConnectionIssue(false)
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        while (!cancelled) {
          const part = await reader.read()
          if (part.done) break
          buffer += decoder.decode(part.value, { stream: true })
          const records = buffer.split('\n\n')
          buffer = records.pop() ?? ''
          for (const record of records) {
            const data = record.split('\n').find(line => line.startsWith('data: '))
            if (!data) continue
            const item = JSON.parse(data.slice(6)) as SessionEvent
            if (item.seq <= seq.current) continue
            if (item.seq !== seq.current + 1) {
              await synchronize()
              continue
            }
            seq.current = item.seq
            if (item.type === 'revision.applying' && item.revision >= appliedRevision.current) setApplying(true)
            if (item.turn) includeTurn(item.turn)
            if (item.type === 'evidence.focus' && item.evidence) await showEvidence(item.evidence)
            if (item.type === 'revision.committed' && item.receipt) await applied(item.receipt)
            else if (item.type.startsWith('proposal.') || item.type.startsWith('topic.') || item.type === 'session.finished') await refresh()
          }
        }
      } catch {
        if (!cancelled) {
          setConnectionIssue(true)
          await synchronize().catch(() => undefined)
        }
      }
      if (!cancelled) timer = window.setTimeout(() => { void consume() }, 400)
    }
    void consume()
    return () => { cancelled = true; abort.abort(); sourceRequest.current?.abort(); window.clearTimeout(timer) }
  }, [initial.id])

  async function mutate<T = Session>(endpoint: string, payload: unknown, label: string, accept?: (data: T) => Promise<void>) {
    setBusy(label); setError('')
    try {
      const data = await request<T>(path + endpoint, payload, session.token)
      if (accept) await accept(data)
      else {
        const state = data as Session
        setSession(previous => previous.seq > state.seq ? previous : { ...state, token: initial.token })
      }
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setBusy('')
    }
  }

  function chooseTopic(item: Topic) {
    if (switchingDisabled) return
    setDetailsOpen(false); setError('')
    if (session.pending && item.id !== topic?.id) {
      setError('Confirm or interrupt the read-back before opening another question.')
      return
    }
    if (session.finished || session.outcomes[item.id] === 'confirmed') {
      setHistoryTopic(item)
      const saved = graph?.claims.find(claim => claim.snapshotId === session.snapshotId && claim.topicId === item.id)
      if (saved) void focusDecision(saved)
      else focusTopic(item)
      return
    }
    if (item.id === topic?.id && !receipt) {
      setHistoryTopic(null)
      focusTopic(item)
      return
    }
    allowVoicePlayback()
    void mutate<Session>('/topic', { topicId: item.id }, 'Opening question…', async state => {
      setSession(previous => previous.seq > state.seq ? previous : { ...state, token: initial.token })
      setConnectAfterSelection(true)
    })
  }

  function returnToInterview() {
    setHistoryTopic(null)
    if (receipt) void focusDecision(receipt.claim)
    else focusTopic(topic)
  }

  function selectNode(node: Node) {
    setSelected(node.id); setActiveEdge(null)
    if (node.path && node.start) {
      void showEvidence({ kind: 'source', path: node.path, start: node.start, end: Math.min(node.end ?? node.start, node.start + 24) })
    } else {
      const confirmed = graph?.claims.find(item => item.snapshotId === session.snapshotId && item.targetId === node.id)
      const ref = confirmed?.evidence.at(-1)
      if (ref) void showEvidence(ref)
    }
  }

  function selectEdge(edge: Edge) {
    setActiveEdge(edge); setSelected(edge.source)
    if (edge.path && edge.start) void showEvidence({ kind: 'source', path: edge.path, start: edge.start, end: edge.end ?? edge.start })
    else {
      const related = graph?.claims.find(claim => claim.claimId === edge.claimId)
      const ref = related?.evidence.at(-1)
      if (ref) void showEvidence(ref)
      else void showEvidence({ kind: 'document', title: edge.relation, text: 'This connection has no pinned source excerpt.' })
    }
  }

  const sourceFiles = useMemo(() => manifest
    ? Object.keys(manifest.files).filter(name => manifest.files[name].text) : [], [manifest])

  function browseEvidence(ref: Evidence, keepDecision = false) {
    if (!keepDecision) {
      setDecisionId(null); setAnchor(null); setSelected(null)
    }
    setActiveEdge(null)
    void showEvidence(ref)
  }

  function openSource(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (file) browseEvidence({ kind: 'source', path: file, start: first, end: last || undefined, snapshotId: sourceSnapshot })
  }

  return (
    <main id="main-content" tabIndex={-1} className="workspace">
      <header className="workspace-heading">
        <div className="workspace-project">
          <Button type="button" variant="ghost" size="sm" className="workspace-back" onClick={onExit}>
            <ArrowLeft aria-hidden="true"/> Repositories
          </Button>
          <div className="workspace-project-name">
            <Github aria-hidden="true" size={26}/>
            <h1 ref={heading} tabIndex={-1} title={session.repo} translate="no">{session.repo}</h1>
          </div>
        </div>
        <div className="workspace-metadata">
          {manifest && <Badge variant="outline" className="commit-tag" title={manifest.commit}>
            <GitCommitHorizontal aria-hidden="true"/> {manifest.commit.slice(0, 7)}
          </Badge>}
          <Badge variant="secondary">{interview ? 'Review' : 'Read only'}</Badge>
          <Sheet open={detailsOpen} onOpenChange={setDetailsOpen}>
            <SheetTrigger asChild><Button type="button" variant="outline" size="sm" className="details-trigger">
              <PanelRight aria-hidden="true"/> Repository details
            </Button></SheetTrigger>
            <SheetContent className="repository-details">
              <SheetHeader>
                <SheetTitle>Repository details</SheetTitle>
                <SheetDescription>{session.repo}</SheetDescription>
              </SheetHeader>
              <div className="detail-groups">
                <ReviewTopics session={session} claims={graph?.claims ?? []} viewingTopic={historyTopic?.id}
                  disabled={switchingDisabled} onTopic={chooseTopic}
                  onClaim={claim => {
                    if (!applying) void focusDecision(claim)
                    setDetailsOpen(false)
                  }}/>
                {manifest && <Coverage manifest={manifest} analysis={analysis}/>}
                {review && Object.keys(review.scopeBaselines).length > 0 &&
                  <PriorReview review={review} manifest={manifest} onOpen={ref => {
                    void showEvidence(ref)
                    setDetailsOpen(false)
                  }}/>}
                {activeQuestion && <Collapsible className="rail-group">
                  <CollapsibleTrigger asChild><Button type="button" variant="ghost" className="rail-trigger">
                    <Settings2 aria-hidden="true"/> Scope or structural change <ChevronDown aria-hidden="true" className="rail-chevron"/>
                  </Button></CollapsibleTrigger>
                  <CollapsibleContent className="review-options">
                    <div>
                      <Label htmlFor="change-type">Change type</Label>
                      <select id="change-type" value={operation} onChange={event => setOperation(event.target.value as Operation)}>
                        <option value="annotate">Record a decision</option>
                        <option value="add_component">Add component</option>
                        <option value="add_connection">Add connection</option>
                      </select>
                    </div>
                    <div><Label htmlFor="change-scope">Scope files or directories</Label>
                      <Input id="change-scope" name="scope" value={scopes} placeholder={activeQuestion.scope} spellCheck={false}
                        onChange={event => setScopes(event.target.value)}/>
                    </div>
                    {operation !== 'annotate' && (
                      <div><Label htmlFor="change-label">{operation === 'add_component' ? 'Component name' : 'Connection type'}</Label>
                        <Input id="change-label" name="change-label" value={changeLabel} onChange={event => setChangeLabel(event.target.value)}/>
                      </div>
                    )}
                    {operation === 'add_connection' && (
                      <div><Label htmlFor="related-component">Connect selected component to</Label>
                        <select id="related-component" value={related} onChange={event => setRelated(event.target.value)}>
                          <option value="">Choose a component</option>
                          {graph?.nodes.filter(node => node.id !== selected).map(node => <option key={node.id} value={node.id}>
                            {node.label}{node.path ? ' · ' + node.path : ''}</option>)}
                        </select>
                      </div>
                    )}
                    {!!graph?.claims.length && <>
                      <div><Label htmlFor="supersedes">Supersede a claim</Label>
                        <select id="supersedes" value={supersedes} onChange={event => setSupersedes(event.target.value)}>
                          <option value="">Keep existing claims</option>
                          {graph.claims.map(claim => <option key={claim.claimId} value={claim.claimId}>{claim.title}</option>)}
                        </select>
                      </div>
                      <div><Label htmlFor="exception">Exception to</Label>
                        <select id="exception" value={exceptionTo} onChange={event => setExceptionTo(event.target.value)}>
                          <option value="">No exception</option>
                          {graph.claims.map(claim => <option key={claim.claimId} value={claim.claimId}>{claim.title}</option>)}
                        </select>
                      </div>
                    </>}
                  </CollapsibleContent>
                </Collapsible>}
                {turns.length > 0 && <Collapsible className="rail-group">
                  <CollapsibleTrigger asChild><Button type="button" variant="ghost" className="rail-trigger">
                    <FileCode2 aria-hidden="true"/> Interview transcript <ChevronDown aria-hidden="true" className="rail-chevron"/>
                  </Button></CollapsibleTrigger>
                  <CollapsibleContent>
                    <ol className="transcript">
                      {turns.map(turn => <li key={turn.id}>
                        <strong>{turn.speaker === 'assistant' ? 'Interviewer' : session.speaker}</strong><p>{turn.text}</p>
                      </li>)}
                    </ol>
                  </CollapsibleContent>
                </Collapsible>}
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </header>

      {connectionIssue && <Alert className="inline-notice" role="status">
        <LoaderCircle aria-hidden="true" className="animate-spin"/>
        <AlertDescription>Reconnecting to the review…</AlertDescription>
      </Alert>}

      <div className="workbench">
        <div className="workbench-content">
          <VoicePresence voice={voice} interview={interview}/>
          <div className="panels">
            <section className="editor-panel" aria-labelledby="architecture-title" ref={architecture}>
              <header className="panel-heading">
                <GitFork aria-hidden="true" size={17}/>
                <h2 id="architecture-title">Architecture</h2>
                <Badge variant="outline">Revision {graph?.revision ?? session.revision}</Badge>
              </header>
              {applying && <div className="panel-progress" role="status">
                <LoaderCircle className="animate-spin" aria-hidden="true" size={14}/> Applying graph revision…
              </div>}
              {graph
                ? <Diagram graph={graph} manifest={manifest} anchor={anchor} selected={selected} selectedEdge={activeEdge}
                    excerpt={sourceSnapshot === session.snapshotId ? excerpt : null} topic={displayedQuestion} decision={decision}
                    onEdge={selectEdge} onAnchor={id => { setDecisionId(null); setAnchor(id) }} onSelect={selectNode}
                    onSource={browseEvidence} onDecision={inspectDecision}/>
                : <div className="panel-empty" aria-busy="true">
                    <Skeleton className="graph-skeleton"/><span>Loading architecture…</span>
                  </div>}
            </section>

            <section className="editor-panel source-panel" aria-labelledby="source-title">
              <header className="panel-heading">
                <Code2 aria-hidden="true" size={17}/>
                <h2 id="source-title">Source evidence</h2>
                {topic && topicSource && !receipt && !session.finished &&
                  <Button type="button" variant="ghost" size="sm"
                    onClick={() => historyTopic ? returnToInterview() : showTopicEvidence(topic, topicSource)}>Current topic</Button>}
                {excerpt && !evidenceNote && <Button asChild variant="ghost" size="icon-sm">
                  <a href={excerpt.url} target="_blank" rel="noreferrer" title="Open pinned lines on GitHub" aria-label="Open pinned lines on GitHub">
                    <ArrowUpRight aria-hidden="true"/>
                  </a>
                </Button>}
              </header>
              {applying && <div className="panel-progress" role="status">
                <LoaderCircle className="animate-spin" aria-hidden="true" size={14}/> Refreshing evidence…
              </div>}

              <Collapsible className="source-browser">
                <CollapsibleTrigger asChild>
                  <Button type="button" variant="ghost" className="source-browser-trigger">
                    <FileCode2 aria-hidden="true"/>
                    <span>Browse source files</span>
                    <ChevronDown aria-hidden="true" className="source-browser-chevron"/>
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <form className="source-form" onSubmit={openSource}>
                    <div className="source-file-field">
                      <Label htmlFor="source-file">Source file</Label>
                      <Input id="source-file" name="path" placeholder="Find a source file…" list="source-files"
                        autoComplete="off" spellCheck={false} value={file}
                        onChange={event => { setFile(event.target.value); setFirst(1); setLast(''); setSourceSnapshot(session.snapshotId) }}/>
                      <datalist id="source-files">{sourceFiles.map(name => <option key={name} value={name}/>)}</datalist>
                    </div>
                    <div><Label htmlFor="first-line">First line</Label>
                      <Input id="first-line" name="start" type="number" min="1" value={first} onChange={event => setFirst(Number(event.target.value))}/>
                    </div>
                    <div><Label htmlFor="last-line">Last line</Label>
                      <Input id="last-line" name="end" type="number" min="1" placeholder="Auto…" value={last}
                        onChange={event => setLast(event.target.value ? Number(event.target.value) : '')}/>
                    </div>
                    <Button type="submit" variant="secondary" size="icon-sm" title="Open source lines" aria-label="Open source lines" disabled={!file}>
                      <Search aria-hidden="true"/>
                    </Button>
                  </form>
                </CollapsibleContent>
              </Collapsible>

              {activeEdge && <div className="edge-detail">
                <strong>{activeEdge.relation}</strong>
                <Badge variant="outline">{activeEdge.origin === 'interview' ? 'Interview confirmed' : activeEdge.origin}</Badge>
              </div>}
              {sourceLoading && !applying && <div className="panel-progress" role="status">
                <LoaderCircle className="animate-spin" aria-hidden="true" size={14}/> Loading source…
              </div>}
              {sourceError
                ? <div className="panel-empty">
                    <CircleAlert aria-hidden="true" size={21}/><p>{sourceError}</p>
                    <Button type="button" size="sm" variant="outline" onClick={() => {
                      const request = latestEvidence.current
                      if (request) void showEvidence(request.ref, request.followConfig)
                    }}>Retry evidence</Button>
                  </div>
                : evidenceNote
                  ? 'claimId' in evidenceNote
                    ? <div className="decision-details"><ClaimEntry claim={evidenceNote} showTitle
                        onOpen={ref => void showEvidence(ref.kind === 'source' && !ref.snapshotId
                          ? { ...ref, snapshotId: evidenceNote.snapshotId } : ref)}/></div>
                    : <article className="attribution">
                      <h3>{evidenceNote.speaker ?? evidenceNote.title}</h3>
                      <p>{evidenceNote.text}</p>
                      {evidenceNote.url && <Button asChild size="sm" variant="link">
                        <a href={evidenceNote.url} target="_blank" rel="noreferrer">Open document <ArrowUpRight aria-hidden="true"/></a>
                      </Button>}
                    </article>
                  : excerpt
                    ? <SourceExcerpt excerpt={excerpt} previous={sourceSnapshot !== session.snapshotId}/>
                    : <div className="panel-empty">
                        <SquareTerminal aria-hidden="true" size={24}/>
                        <p>Select a component or open a source file to see its evidence.</p>
                      </div>}
            </section>
          </div>

          <section className="editor-panel interview-console" aria-labelledby="interview-title" data-receipt={!!receipt || !!historyTopic}>
            <header className="panel-heading">
              <h2 id="interview-title">{interview ? 'Architecture interview' : 'Ask the lineage'}</h2>
              {displayedQuestion && <Badge variant="outline">Question {displayedIndex + 1} of {session.topics.length}</Badge>}
              {historyTopic && session.outcomes[historyTopic.id] === 'confirmed' && <Badge variant="secondary">Confirmed</Badge>}
            </header>
            <div className="interview-body">
              {error && <Alert variant="destructive" className="inline-notice">
                <CircleAlert aria-hidden="true"/><AlertDescription>{error}</AlertDescription>
              </Alert>}

              {interview && receipt && !historyTopic && (
                <div className="claim-receipt">
                  <Alert className="inline-notice receipt" role="status">
                    <Check aria-hidden="true"/>
                    <AlertDescription>Added to architecture · Revision {receipt.revision} · {receipt.claim.statement}</AlertDescription>
                  </Alert>
                  <div className="receipt-actions">
                    <EvidenceLinks items={receipt.claim.evidence} onOpen={ref => void showEvidence(ref)}/>
                    {topic && <Button type="button" size="sm" variant="secondary" disabled={switchingDisabled}
                      onClick={() => chooseTopic(topic)}>Next question <ArrowRight aria-hidden="true"/></Button>}
                  </div>
                </div>
              )}
              {displayedQuestion && <article className="interview-question">
                <h3>{displayedQuestion.question}</h3>
                <p>{displayedQuestion.statement}</p>
                <EvidenceLinks items={displayedQuestion.evidence} onOpen={ref => historyTopic && decision
                  ? void showEvidence(ref) : showTopicEvidence(displayedQuestion, ref, false)}/>
              </article>}
              {historyTopic && !session.finished && <div className="controls">
                <Button type="button" size="sm" variant="secondary" onClick={returnToInterview}>Return to interview</Button>
              </div>}
              {interview && !session.finished && !topic && !historyTopic && <p className="subtle">You’ve reached the end of the interview.</p>}
              {session.pending && !historyTopic && (
                <div className="readback">
                  <strong>Confirm the read-back</strong>
                  <p>{session.pending.summary}</p>
                  <div className="controls">
                    {!session.pending.readbackTurnId && <Button type="button" size="sm" variant="secondary" disabled={working}
                      onClick={() => void mutate('/readback', { proposalId: session.pending?.id }, 'Acknowledging read-back…')}>
                      I reviewed this summary</Button>}
                    <Button type="button" size="sm" disabled={working || !session.pending.readbackTurnId}
                      onClick={() => void mutate<Revision>('/confirm', {
                        proposalId: session.pending?.id, readbackTurnId: session.pending?.readbackTurnId,
                      }, 'Confirming…', applied)}><Check aria-hidden="true"/> Confirm and save</Button>
                    <Button type="button" variant="ghost" size="sm" disabled={working}
                      onClick={() => void mutate('/interrupt', { proposalId: session.pending?.id }, 'Withdrawing read-back…')}>
                      Interrupt read-back</Button>
                  </div>
                </div>
              )}

              {!session.finished && !historyTopic && <div className="interview-actions">
                {(!interview || activeQuestion) && <VoiceControls voice={voice} interview={interview}
                  question={!!activeQuestion && !session.pending} correction={!!session.pending} change={change} busy={!!busy}/>}
                {interview && <div className="controls bottom-controls">
                  {activeQuestion && !session.pending && <Button type="button" variant="ghost" size="sm" disabled={switchingDisabled}
                    onClick={() => void mutate('/skip', {}, 'Skipping…')}>Skip question</Button>}
                  <Button type="button" size="sm" variant="outline" disabled={working || !!session.pending}
                    onClick={() => void mutate('/finish', {}, 'Finishing…')}>Finish review</Button>
                </div>}
              </div>}
              {session.finished && <Alert className="inline-notice receipt" role="status">
                <Check aria-hidden="true"/><AlertDescription>Review finished.</AlertDescription>
              </Alert>}
            </div>
          </section>
        </div>
      </div>
    </main>
  )
}
