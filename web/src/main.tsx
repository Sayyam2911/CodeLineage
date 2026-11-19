import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { createRoot } from 'react-dom/client'
import {
  ArrowLeft, ArrowRight, ArrowUpRight, AudioLines, BookOpen, Check, CircleAlert,
  Code2, FileCode, GitBranch, GitFork, Github, LoaderCircle, Search, Send, SquareTerminal,
} from 'lucide-react'
import { Diagram } from './Diagram'
import { Home } from './Home'
import { ClaimEntry, Coverage, EvidenceLinks, PriorReview } from './Review'
import { Voice } from './Voice'
import { ApiError, query, request, sleep } from './api'
import type { Analysis, Context, Edge, Evidence, Excerpt, Graph, Manifest, Mode, Node, Review, Revision, Scan, Session, SessionEvent, Turn } from './api'
import '@fontsource-variable/geist'
import './styles.css'

const healthchecks = 'https://github.com/healthchecks/healthchecks'
const storageKey = 'codelineage-session'
type SessionKey = Pick<Session, 'id' | 'token'>
type Operation = 'annotate' | 'add_component' | 'add_connection'

function Intake({ mode, onOpen, onBack, onSwitch }: {
  mode: Mode; onOpen: (session: Session) => void; onBack: () => void; onSwitch: () => void
}) {
  const [url, setUrl] = useState('')
  const [ref, setRef] = useState('')
  const [scope, setScope] = useState('')
  const [speaker, setSpeaker] = useState('')
  const [progress, setProgress] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const intakeAbort = useRef<AbortController | null>(null)
  useEffect(() => () => intakeAbort.current?.abort(), [])

  async function open(event: FormEvent) {
    event.preventDefault()
    setBusy(true); setError('')
    intakeAbort.current?.abort()
    const active = new AbortController()
    intakeAbort.current = active
    try {
      let snapshotId: string | undefined
      if (mode === 'update') {
        setProgress('Resolving the GitHub commit…')
        let scan = await request<Scan>('/scans', { url, ref: ref.trim() || null, scope: scope.trim() || null }, undefined, active.signal)
        while (scan.status === 'queued' || scan.status === 'scanning' || scan.status === 'analyzing') {
          const labels = { queued: 'Scan queued…', scanning: 'Capturing source and extracting structure…', analyzing: 'Reviewing source evidence…' }
          setProgress(labels[scan.status])
          await sleep(850)
          scan = await request<Scan>('/scans/' + scan.id, undefined, undefined, active.signal)
        }
        if (scan.status === 'failed' || !scan.snapshotId) throw new Error(scan.error ?? 'No snapshot was produced.')
        snapshotId = scan.snapshotId
        setProgress(scan.reused ? 'Opening the saved scan…' : 'Preparing review topics…')
      }
      onOpen(await request<Session>('/sessions', {
        url, mode, snapshotId, speaker: speaker.trim() || 'Interview participant',
      }, undefined, active.signal))
    } catch (reason) {
      if (!active.signal.aborted) setError((reason as Error).message)
    } finally {
      if (!active.signal.aborted) { setProgress(''); setBusy(false) }
    }
  }

  return <main className="intake">
    <button className="quiet back" onClick={onBack}><ArrowLeft size={16}/> Home</button>
    <div className="intake-body">
      <span className="action-icon">{mode === 'update' ? <GitFork size={24}/> : <BookOpen size={24}/>}</span>
      <h1>{mode === 'update' ? 'Create or update code lineage' : 'Understand code lineage'}</h1>
      <p>{mode === 'update' ? 'Pin a repository to a commit and prepare questions grounded in its source.' : 'Open a reviewed repository to explore its architecture and the decisions behind it.'}</p>
      <form onSubmit={open}>
        <label htmlFor="repository">Public GitHub repository</label>
        <div className="input-icon"><Github size={18}/><input id="repository" type="url"
          required placeholder="https://github.com/owner/repository" value={url} onChange={event => setUrl(event.target.value)}/></div>
        <button className="quiet demo-link" type="button" disabled={busy} onClick={() => setUrl(healthchecks)}>Use the Healthchecks demo <ArrowUpRight size={14}/></button>
        {mode === 'update' && <details>
          <summary>Review options</summary>
          <div className="review-options">
            <label>Branch, tag or SHA<input value={ref} onChange={event => setRef(event.target.value)} placeholder="Default branch"/></label>
            <label>Directory scope<input value={scope} onChange={event => setScope(event.target.value)} placeholder="Entire repository"/></label>
            <label>Your display name<input value={speaker} onChange={event => setSpeaker(event.target.value)} placeholder="Interview participant"/></label>
          </div>
        </details>}
        {error && <div className="notice error" role="alert"><CircleAlert size={18}/><span>{error}</span></div>}
        {mode === 'understand' && /No reviewed lineage/.test(error) &&
          <button className="quiet" type="button" onClick={onSwitch}>Create or update code lineage <ArrowRight size={16}/></button>}
        <button className="primary submit" type="submit" disabled={busy}>
          {busy ? <><LoaderCircle size={17} className="spin"/> {progress || 'Opening lineage…'}</>
            : <>{mode === 'update' ? 'Analyze repository' : 'Open reviewed lineage'} <ArrowRight size={17}/></>}
        </button>
      </form>
    </div>
  </main>
}

function Workspace({ initial, onExit }: { initial: Session; onExit: () => void }) {
  const [session, setSession] = useState(initial)
  const [graph, setGraph] = useState<Graph | null>(null)
  const [manifest, setManifest] = useState<Manifest | null>(null)
  const [analysis, setAnalysis] = useState<Analysis | null>(null)
  const [review, setReview] = useState<Review | null>(null)
  const [turns, setTurns] = useState<Turn[]>([])
  const [activeEdge, setActiveEdge] = useState<Edge | null>(null)
  const [connectionIssue, setConnectionIssue] = useState(false)
  const [excerpt, setExcerpt] = useState<Excerpt | null>(null)
  const [evidenceNote, setEvidenceNote] = useState<Evidence | null>(null)
  const [sourceError, setSourceError] = useState('')
  const [sourceLoading, setSourceLoading] = useState(false)
  const [sourceSnapshot, setSourceSnapshot] = useState(initial.snapshotId)
  const latestEvidence = useRef<Evidence | null>(null)
  const sourceRequest = useRef<AbortController | null>(null)
  const [anchor, setAnchor] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [file, setFile] = useState('')
  const [first, setFirst] = useState(1)
  const [last, setLast] = useState<number | ''>('')
  const [input, setInput] = useState('')
  const [operation, setOperation] = useState<Operation>('annotate')
  const [changeLabel, setChangeLabel] = useState('')
  const [related, setRelated] = useState('')
  const [scopes, setScopes] = useState('')
  const [supersedes, setSupersedes] = useState('')
  const [exceptionTo, setExceptionTo] = useState('')
  const [result, setResult] = useState<Context | null>(null)
  const [asked, setAsked] = useState('')
  const [receipt, setReceipt] = useState<Revision | null>(initial.pending || initial.finished ? null : initial.latestReceipt ?? null)
  const appliedRevision = useRef(initial.latestReceipt?.revision ?? 0)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [applying, setApplying] = useState(false)
  const seq = useRef(initial.seq)
  const shownRevision = useRef(initial.revision)
  const sourceSequence = useRef(0)
  const path = '/sessions/' + session.id
  const snapshot = '/snapshots/' + session.snapshotId
  const topic = session.topics[session.index]
  const interview = session.mode === 'update'

  async function showEvidence(ref: Evidence) {
    sourceRequest.current?.abort()
    const controller = new AbortController()
    sourceRequest.current = controller
    const requestId = ++sourceSequence.current
    latestEvidence.current = ref
    setSourceError('')
    setEvidenceNote(ref.kind !== 'source' ? ref : null)
    if (ref.kind !== 'source' || !ref.path || !ref.start) {
      setExcerpt(null); setSourceLoading(false)
      return
    }
    const evidenceSnapshot = ref.snapshotId ?? session.snapshotId
    setSourceSnapshot(evidenceSnapshot)
    setFile(ref.path); setFirst(ref.start); setLast(ref.end ?? '')
    setSourceLoading(true)
    try {
      const data = await request<Excerpt>(query('/snapshots/' + evidenceSnapshot + '/source', {
        path: ref.path, start: ref.start, ...(ref.end ? { end: ref.end } : {}),
      }), undefined, undefined, controller.signal)
      if (requestId === sourceSequence.current) setExcerpt(data)
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

  function focusTopic(active: typeof topic) {
    if (!active) return
    setAnchor(active.targetId); setSelected(active.targetId); setActiveEdge(null)
    setOperation('annotate'); setChangeLabel(''); setRelated(''); setScopes(''); setSupersedes(''); setExceptionTo('')
    const ref = active.evidence.find(item => item.kind === 'source')
    if (ref) void showEvidence(ref)
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
    setReceipt(change)
    setActiveEdge(null)
    setOperation('annotate'); setChangeLabel(''); setRelated(''); setScopes(''); setSupersedes(''); setExceptionTo('')
    setApplying(true)
    try {
      const reference = (change.claim.operation === 'add_component'
        ? change.claim.evidence.find(item => item.kind === 'interview')
        : change.claim.evidence.find(item => item.kind === 'source')) ?? change.claim.evidence.at(-1)
      if (change.claim.targetId) setSelected(change.claim.targetId)
      await Promise.all([loadGraph(change.revision), refresh(), loadTurns(), reference ? showEvidence(reference) : undefined])
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
    if (initial.evidenceFocus) void showEvidence(initial.evidenceFocus)
    else if (initial.latestReceipt && !initial.pending) {
      setSelected(initial.latestReceipt.claim.targetId)
      const ref = initial.latestReceipt.claim.evidence[0]
      if (ref) void showEvidence(ref)
    } else focusTopic(initial.topics[initial.index])

    async function synchronize() {
      const state = await refresh(true)
      if (state.latestReceipt && state.latestReceipt.revision > appliedRevision.current) await applied(state.latestReceipt)
      else if (state.revision > shownRevision.current) await loadGraph(state.revision)
      if (state.evidenceFocus) await showEvidence(state.evidenceFocus)
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
            else if (item.type.startsWith('proposal.') || item.type.startsWith('topic.') || item.type === 'session.finished') {
              const state = await refresh()
              if (item.type === 'topic.open') focusTopic(state.topics[state.index])
            }
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

  async function send(event: FormEvent) {
    event.preventDefault()
    const text = input.trim()
    if (!text) return
    if (interview) {
      const change = {
        text, operation, scope: scopes.trim() ? scopes.split(',').map(value => value.trim()).filter(Boolean) : null,
        targetId: selected, relatedId: related || null, label: changeLabel.trim() || null,
        supersedes: supersedes || null, exceptionTo: exceptionTo || null,
      }
      await mutate<Session>('/answer', change, 'Preparing read-back…', async staged => {
        const reviewed = staged.pending
          ? await request<Session>(path + '/readback', { proposalId: staged.pending.id }, session.token)
          : staged
        setSession(previous => previous.seq > reviewed.seq ? previous : { ...reviewed, token: session.token })
        setInput('')
        if (!reviewed.pending) focusTopic(reviewed.topics[reviewed.index])
      })
    } else {
      await mutate<Context>('/context', { text }, 'Finding evidence…', async reply => {
        setAsked(text); setInput(''); setResult(reply)
        if (reply.focus) { setAnchor(reply.focus.id); setSelected(reply.focus.id) }
        const ref = reply.evidence.find(item => item.kind === 'source')
        if (ref) void showEvidence(ref)
      })
    }
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
  const sourceCommit = excerpt?.commit ?? manifest?.commit

  return <main className="workspace">
    <div className="workspace-heading">
      <button className="quiet back" onClick={onExit}><ArrowLeft size={16}/> Home</button>
      <div className="workspace-repo"><Github size={19}/><h1>{session.repo}</h1>
        <span className="commit"><GitBranch size={14}/>{manifest?.commit.slice(0, 7) ?? '…'}</span>
      </div>
      <span className="workspace-mode">{interview ? 'Lineage review' : 'Read-only lineage'}</span>
    </div>
    {connectionIssue && <div className="notice connection" role="status">Reconnecting to the review…</div>}
    <div className="review-strips">
      {manifest && <Coverage manifest={manifest} analysis={analysis}/>}
      {review && Object.keys(review.scopeBaselines).length > 0 &&
        <PriorReview review={review} manifest={manifest} onOpen={ref => void showEvidence(ref)}/>}
    </div>
    <div className="panels">
      <section className="panel">
        <header className="panel-heading"><GitFork size={19}/><h2>Architecture</h2><span>Revision {graph?.revision ?? session.revision}</span></header>
        {applying && <div className="progress"><LoaderCircle className="spin" size={15}/> Applying graph revision</div>}
        {graph ? <Diagram graph={graph} anchor={anchor} selected={selected} selectedEdge={activeEdge}
          onEdge={selectEdge} onAnchor={setAnchor} onSelect={selectNode}/>
          : <div className="panel-empty"><LoaderCircle className="spin" size={24}/><p>Loading architecture…</p></div>}
      </section>
      <section className="panel">
        <header className="panel-heading"><Code2 size={20}/><h2>Source evidence</h2>
          {excerpt && <a className="quiet" href={excerpt.url} target="_blank" rel="noreferrer">GitHub <ArrowUpRight size={14}/></a>}</header>
        {applying && <div className="progress"><LoaderCircle className="spin" size={15}/> Refreshing evidence</div>}
        <form className="source-form" onSubmit={event => {
          event.preventDefault()
          void showEvidence({ kind: 'source', path: file, start: first, end: last || undefined, snapshotId: sourceSnapshot })
        }}>
          <label className="source-picker"><FileCode size={15}/>
            <input aria-label="Source file" placeholder="Find a source file" list="source-files" value={file}
              onChange={event => { setFile(event.target.value); setFirst(1); setLast(''); setSourceSnapshot(session.snapshotId) }}/></label>
          <datalist id="source-files">{sourceFiles.map(name => <option key={name} value={name}/>)}</datalist>
          <input aria-label="First line" type="number" min="1" value={first} onChange={event => setFirst(Number(event.target.value))}/>
          <input aria-label="Last line" type="number" min="1" placeholder="Auto" value={last} onChange={event => setLast(event.target.value ? Number(event.target.value) : '')}/>
          <button type="submit" title="Open source lines" aria-label="Open source lines" disabled={!file}><Search size={16}/></button>
        </form>
        {activeEdge && <div className="edge-detail">
          <strong>{activeEdge.relation}</strong><span>{activeEdge.origin === 'interview' ? 'Interview confirmed' : activeEdge.origin}</span>
        </div>}
        {sourceLoading && !applying && <div className="progress" role="status"><LoaderCircle className="spin" size={15}/> Loading source</div>}
        {sourceError ? <div className="panel-empty"><CircleAlert size={22}/><p>{sourceError}</p>
          <button type="button" className="quiet" onClick={() => { if (latestEvidence.current) void showEvidence(latestEvidence.current) }}>Retry evidence</button></div>
          : evidenceNote ? <div className="attribution">
            {evidenceNote.kind === 'interview' ? <AudioLines size={20}/> : <BookOpen size={20}/>}
            <h3>{evidenceNote.speaker ?? evidenceNote.title}</h3><p>{evidenceNote.text}</p>
            {evidenceNote.url && <a className="quiet evidence-link" href={evidenceNote.url} target="_blank" rel="noreferrer">Open document <ArrowUpRight size={14}/></a>}
          </div>
          : excerpt ? <div className="code">
            <div className="code-meta">{excerpt.path}<span title={sourceCommit}>{sourceCommit?.slice(0, 7)}{sourceSnapshot !== session.snapshotId ? ' · previous' : ''}</span></div>
            <div className="code-scroll" aria-label="Pinned source lines" tabIndex={0}>
              {excerpt.lines.map(line => <div className="code-row" key={line.number}><span>{line.number}</span><code>{line.text || ' '}</code></div>)}
            </div>
          </div> : <div className="panel-empty"><SquareTerminal size={27}/><p>Select a component or open a source file to see its evidence.</p></div>}
      </section>
    </div>
    <section className="conversation">
      <header className="panel-heading"><AudioLines size={20}/><h2>{interview ? 'Interview' : 'Ask the lineage'}</h2>
        <span>{interview && topic && !session.finished ? 'Topic ' + (session.index + 1) + ' of ' + session.topics.length : ''}</span></header>
      <div className="conversation-body">
        <Voice sessionId={session.id} token={session.token} disabled={session.finished}/>
        {error && <div className="notice error" role="alert"><CircleAlert size={18}/><span>{error}</span></div>}
        {interview && receipt && <div className="receipt" role="status"><Check size={17}/>
          <span>Saved revision {receipt.revision} · {receipt.claim.statement}</span>
          {topic && !session.finished && <button className="quiet" onClick={() => { setReceipt(null); focusTopic(topic) }}>Next topic <ArrowRight size={16}/></button>}</div>}
        {interview && receipt && <EvidenceLinks items={receipt.claim.evidence} onOpen={ref => void showEvidence(ref)}/>}
        {interview && !session.finished && topic && !receipt && <div className="topic">
          <h3>{topic.question}</h3><p>{topic.statement}</p>
          <EvidenceLinks items={topic.evidence} onOpen={ref => void showEvidence(ref)}/>
        </div>}
        {interview && !session.finished && !topic && <p className="subtle">There are no remaining interview topics for this scan.</p>}
        {session.pending && <div className="readback">
          <strong>Confirm the read-back</strong><p>{session.pending.summary}</p>
          <div className="controls">
            {!session.pending.readbackTurnId && <button className="quiet" disabled={!!busy}
              onClick={() => void mutate('/readback', { proposalId: session.pending?.id }, 'Acknowledging read-back…')}>
              I reviewed this summary</button>}
            <button className="primary" disabled={!!busy || !session.pending.readbackTurnId}
            onClick={() => void mutate<Revision>('/confirm', {
              proposalId: session.pending?.id, readbackTurnId: session.pending?.readbackTurnId,
            }, 'Confirming…', applied)}><Check size={17}/> Confirm and save</button>
            <button className="quiet" disabled={!!busy} onClick={() => void mutate('/interrupt', {
              proposalId: session.pending?.id,
            }, 'Withdrawing read-back…')}>Interrupt read-back</button></div>
        </div>}
        {!interview && result && <div className="context-result">
          <h3>{asked}</h3>
          {result.answer && <p className="grounded-answer">{result.answer}</p>}
          {result.claims.map(claim => <ClaimEntry key={claim.claimId} claim={claim} onOpen={ref => void showEvidence(ref)}/>)}
          {result.findings.map(finding => <div className="context-entry" key={finding.id}>
            <strong>{finding.statement}</strong><p>{finding.origin === 'inference' ? 'Model inference' : 'Code evidence'}</p>
            <EvidenceLinks items={finding.evidence} onOpen={ref => void showEvidence(ref)}/>
          </div>)}
          {result.hops.length > 0 && <p>Supported path · {result.hops[0].fromLabel} → {result.hops.map(hop => hop.toLabel).join(' → ')}</p>}
          {result.documents.map(doc => <a key={doc.path} className="quiet evidence-link" href={doc.url} target="_blank" rel="noreferrer">{doc.path} <ArrowUpRight size={13}/></a>)}
          {result.unknown && <p className="subtle">The reviewed lineage has no confirmed rationale for that question.</p>}
        </div>}
        {interview && !session.finished && topic && !receipt && <details className="change-options">
          <summary>Scope or structural change</summary>
          <div className="review-options">
            <label>Change type<select value={operation} onChange={event => setOperation(event.target.value as Operation)}>
              <option value="annotate">Annotate component</option><option value="add_component">Add component</option>
              <option value="add_connection">Add connection</option>
            </select></label>
            <label>Scope files or directories<input value={scopes} placeholder={topic.scope}
              onChange={event => setScopes(event.target.value)}/></label>
            {operation !== 'annotate' && <label>{operation === 'add_component' ? 'Component name' : 'Connection type'}
              <input value={changeLabel} onChange={event => setChangeLabel(event.target.value)}/></label>}
            {operation === 'add_connection' && <label>Connect selected component to
              <select value={related} onChange={event => setRelated(event.target.value)}>
                <option value="">Choose a component</option>
                {graph?.nodes.filter(node => node.id !== selected).map(node => <option key={node.id} value={node.id}>
                  {node.label}{node.path ? ' · ' + node.path : ''}</option>)}
              </select></label>}
            {!!graph?.claims.length && <>
              <label>Supersede a claim<select value={supersedes} onChange={event => setSupersedes(event.target.value)}>
                <option value="">Keep existing claims</option>
                {graph.claims.map(claim => <option key={claim.claimId} value={claim.claimId}>{claim.title}</option>)}
              </select></label>
              <label>Exception to<select value={exceptionTo} onChange={event => setExceptionTo(event.target.value)}>
                <option value="">No exception</option>
                {graph.claims.map(claim => <option key={claim.claimId} value={claim.claimId}>{claim.title}</option>)}
              </select></label>
            </>}
          </div>
        </details>}
        {!session.finished && (!interview || (topic && !receipt)) && <form className="composer" onSubmit={send}>
          <input aria-label={interview ? 'Interview answer' : 'Question'} value={input}
            placeholder={interview ? (session.pending ? 'Type a correction…' : 'Type your answer…') : 'Ask why a part of this code behaves the way it does…'}
            onChange={event => setInput(event.target.value)}/>
          <button className="primary" type="submit" aria-label="Send" disabled={!!busy || !input.trim()}>
            {busy ? <LoaderCircle size={17} className="spin"/> : <Send size={17}/>}</button>
        </form>}
        {interview && !session.finished && <div className="controls bottom-controls">
          {topic && !receipt && <button className="quiet" disabled={!!busy} onClick={() => void mutate<Session>(
            '/skip', {}, 'Skipping…', async next => {
              setSession(previous => previous.seq > next.seq ? previous : { ...next, token: initial.token })
              focusTopic(next.topics[next.index])
            })}>Skip question</button>}
          <button className="quiet" disabled={!!busy} onClick={() => void mutate('/finish', {}, 'Finishing…')}>Finish review</button>
        </div>}
        {turns.length > 0 && <details className="transcript">
          <summary>Transcript <span>{turns.length} turns</span></summary>
          <ol>{turns.map(turn => <li key={turn.id}><strong>{turn.speaker === 'assistant' ? 'Assistant' : session.speaker}</strong><p>{turn.text}</p></li>)}</ol>
        </details>}
        {session.finished && <div className="notice"><Check size={17}/> Review finished.</div>}
      </div>
    </section>
  </main>
}

function App() {
  const [mode, setMode] = useState<Mode | null>(null)
  const [session, setSession] = useState<Session | null>(null)
  const [resumeError, setResumeError] = useState('')
  const [restoring, setRestoring] = useState(() => sessionStorage.getItem(storageKey) !== null)

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
      sessionStorage.removeItem(storageKey); setRestoring(false)
    }
    return () => controller.abort()
  }, [restoring])

  function exit() {
    sessionStorage.removeItem(storageKey)
    setSession(null); setMode(null); setRestoring(false); setResumeError('')
  }

  return <>
    <header className="topbar">
      <button className="brand" onClick={exit} aria-label="CodeLineage home"><span><GitFork size={22}/></span>CodeLineage</button>
      {session && <span className="topbar-session"><span/> Active workspace</span>}
    </header>
    {restoring ? <main className="intake" role="status"><LoaderCircle className="spin" size={20}/> Restoring review…</main>
      : resumeError ? <main className="intake"><div className="notice error" role="alert">{resumeError}</div><div className="controls resume-actions">
        <button className="primary" onClick={() => { setResumeError(''); setRestoring(true) }}>Retry review</button>
        <button className="quiet" onClick={exit}>Home</button></div></main>
      : session ? <Workspace key={session.id} initial={session} onExit={exit}/>
      : mode ? <Intake key={mode} mode={mode} onBack={exit} onSwitch={() => setMode('update')} onOpen={next => {
        sessionStorage.setItem(storageKey, JSON.stringify({ id: next.id, token: next.token } satisfies SessionKey))
        setSession(next)
      }}/> : <Home onSelect={setMode}/>}
  </>
}

createRoot(document.getElementById('root')!).render(<App/>)
