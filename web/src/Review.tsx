import { useState } from 'react'
import { ArrowUpRight, BookOpen, Check, ChevronDown, Circle, FileCode, GitCompareArrows, Layers, Search } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { Analysis, Claim, Evidence, Manifest, Review, Session, Topic } from './api'

const coverageNames: Record<string, string> = {
  parsed: 'Parsed', unparsed: 'Unparsed text', failed: 'Parser failed',
  binary: 'Binary', 'out-of-scope': 'Outside scope', 'non-regular': 'Non-regular files',
}

export function EvidenceLinks({ items, onOpen }: { items: Evidence[]; onOpen: (item: Evidence) => void }) {
  if (!items.length) return null
  return (
    <div className="evidence-links">
      {items.map((item, index) => (
        <Button key={index} type="button" variant="outline" size="sm" className="evidence-link" onClick={() => onOpen(item)}>
          {item.kind === 'source' ? <FileCode aria-hidden="true"/> : <BookOpen aria-hidden="true"/>}
          {item.kind === 'source' ? (item.path ?? 'Source') + ':' + item.start
            : item.kind === 'document' ? item.title ?? 'Supporting document' : 'Interview turn'}
        </Button>
      ))}
    </div>
  )
}

export function Coverage({ manifest, analysis }: { manifest: Manifest; analysis: Analysis | null }) {
  return (
    <Collapsible className="rail-group">
      <CollapsibleTrigger asChild><Button variant="ghost" className="rail-trigger">
        <Layers aria-hidden="true"/> Snapshot coverage <ChevronDown aria-hidden="true" className="rail-chevron"/>
      </Button></CollapsibleTrigger>
      <CollapsibleContent className="coverage-details">
        <dl>{Object.entries(manifest.coverage).map(([status, total]) => (
          <div key={status}><dt>{coverageNames[status] ?? status}</dt><dd>{total.toLocaleString()}</dd></div>
        ))}</dl>
        <p>{analysis?.mode === 'local' ? 'Structural review available.'
          : analysis ? (analysis.complete ? 'Complete' : 'Partial') + ' model review · '
            + Object.values(analysis.coverage ?? {}).filter(status => status === 'reviewed').length.toLocaleString() + ' files reviewed'
          : 'Loading review coverage…'}</p>
        {manifest.scope && <p>Directory scope <code>{manifest.scope}</code></p>}
      </CollapsibleContent>
    </Collapsible>
  )
}

export function PriorReview({ review, manifest, onOpen }: {
  review: Review; manifest: Manifest | null; onOpen: (item: Evidence) => void
}) {
  const [filter, setFilter] = useState('')
  const changes = review.changes ?? review.changedPaths.map(path => ({
    path, kind: manifest?.files[path] ? 'modified' : 'deleted', baseline: review.baseline ?? undefined,
  }))
  const selected = changes.filter(item => item.path.toLowerCase().includes(filter.toLowerCase()))
  return (
    <Collapsible className="rail-group">
      <CollapsibleTrigger asChild><Button type="button" variant="ghost" className="rail-trigger">
        <GitCompareArrows aria-hidden="true"/> Changes since review <ChevronDown aria-hidden="true" className="rail-chevron"/>
      </Button></CollapsibleTrigger>
      <CollapsibleContent className="review-details">
        <p>{review.changedPaths.length} changed · {review.affectedPaths.length} affected</p>
        {review.wideReview && <p>The change spans a large part of the repository. Review the affected scopes before recording a baseline.</p>}
        {review.uncertainSymbols?.length ? <p>{review.uncertainSymbols.length} possible symbol matches need review.</p> : null}
        {!!changes.length && (
          <div className="review-filter">
            <Search aria-hidden="true" size={14}/>
            <Input aria-label="Filter changed files" placeholder="Filter changed files…" value={filter} onChange={event => setFilter(event.target.value)}/>
          </div>
        )}
        <div className="changed-files">
          {selected.slice(0, 40).map(item => (
            <div key={item.path} className="changed-file">
              <span title={item.path}>{item.path}</span><small>{item.kind}</small>
              <div>
                {manifest?.files[item.path]?.text && <Button size="sm" type="button" variant="ghost" onClick={() => onOpen({
                  kind: 'source', path: item.path, start: 1,
                })}>Current</Button>}
                {item.baseline && item.kind !== 'added' && <Button size="sm" type="button" variant="ghost" onClick={() => onOpen({
                  kind: 'source', snapshotId: item.baseline, path: 'previousPath' in item && item.previousPath ? item.previousPath : item.path, start: 1,
                })}>Previous</Button>}
              </div>
            </div>
          ))}
        </div>
        {selected.length > 40 && <p>Showing 40 of {selected.length} files. Filter by path to find others.</p>}
        {!changes.length && <p>No source changes in the reviewed scopes.</p>}
        {review.priorClaims.map(claim => <ClaimEntry key={claim.claimId} claim={claim} onOpen={onOpen}/>)}
      </CollapsibleContent>
    </Collapsible>
  )
}

export function ClaimEntry({ claim, onOpen }: { claim: Claim; onOpen: (item: Evidence) => void }) {
  return (
    <article className="context-entry">
      <strong>{claim.statement}</strong><p>Confirmed by {claim.speaker} · {claim.scopes.join(', ')}</p>
      <EvidenceLinks items={claim.evidence} onOpen={onOpen}/>
    </article>
  )
}

export function ReviewTopics({ session, claims, onTopic, onClaim }: {
  session: Session
  claims: Claim[]
  onTopic: (item: Topic) => void
  onClaim: (item: Claim) => void
}) {
  const update = session.mode === 'update'
  const outcomes = session.outcomes ?? {}
  const confirmed = Object.values(outcomes).filter(status => status === 'confirmed').length
  return (
    <Collapsible className="rail-group" defaultOpen>
      <CollapsibleTrigger asChild><Button type="button" variant="ghost" className="rail-trigger">
        {update ? <Layers aria-hidden="true"/> : <BookOpen aria-hidden="true"/>}
        <span>{update ? 'Review topics' : 'Reviewed decisions'}</span>
        <Badge variant="outline">{update ? confirmed + '/' + session.topics.length : claims.length}</Badge>
        <ChevronDown aria-hidden="true" className="rail-chevron"/>
      </Button></CollapsibleTrigger>
      <CollapsibleContent>
        <ScrollArea className="topic-list-scroll">
          <div className="topic-list">
            {update ? session.topics.map((item, index) => (
              <Button key={item.id} type="button" variant="ghost"
                aria-current={index === session.index && !session.finished ? 'step' : undefined} onClick={() => onTopic(item)}
                title={item.title}>
                {outcomes[item.id] === 'confirmed' ? <Check aria-hidden="true"/> : <Circle aria-hidden="true"/>}
                <span>{item.title}</span><ArrowUpRight aria-hidden="true"/>
              </Button>
            )) : claims.map(claim => (
              <Button key={claim.claimId} type="button" variant="ghost" onClick={() => onClaim(claim)} title={claim.statement}>
                <Check aria-hidden="true"/><span>{claim.title}</span><ArrowUpRight aria-hidden="true"/>
              </Button>
            ))}
            {!(update ? session.topics.length : claims.length) &&
              <p>{update ? 'No review topics in this scope.' : 'No decisions have been recorded for this view.'}</p>}
          </div>
        </ScrollArea>
      </CollapsibleContent>
    </Collapsible>
  )
}
