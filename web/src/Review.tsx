import { useState } from 'react'
import { FileCode, GitCompareArrows, Layers, Search } from 'lucide-react'
import type { Analysis, Claim, Evidence, Manifest, Review } from './api'

const coverageNames: Record<string, string> = {
  parsed: 'Parsed', unparsed: 'Unparsed text', failed: 'Parser failed',
  binary: 'Binary', 'out-of-scope': 'Outside scope', 'non-regular': 'Non-regular files',
}

export function EvidenceLinks({ items, onOpen }: { items: Evidence[]; onOpen: (item: Evidence) => void }) {
  if (!items.length) return null
  return <div className="evidence-links">
    {items.map((item, index) => <button className="quiet evidence-link" type="button"
      key={index} onClick={() => onOpen(item)}>
      {item.kind === 'source' ? (item.path ?? 'Source') + ':' + item.start
        : item.kind === 'document' ? item.title ?? 'Supporting document' : 'Interview turn'}
    </button>)}
  </div>
}

export function Coverage({ manifest, analysis }: { manifest: Manifest; analysis: Analysis | null }) {
  const count = Object.keys(manifest.files).length
  return <details className="review-strip">
    <summary><Layers size={16}/> Snapshot coverage <span>{count.toLocaleString()} files</span></summary>
    <div className="coverage-details">
      <div><strong>Structural index</strong><dl>{Object.entries(manifest.coverage).map(([status, total]) =>
        <div key={status}><dt>{coverageNames[status] ?? status}</dt><dd>{total.toLocaleString()}</dd></div>)}</dl></div>
      <div><strong>Semantic review</strong><p>{analysis?.mode === 'local'
        ? 'Structural interview topics are available. Model review is disabled.'
        : analysis ? (analysis.complete ? 'Complete' : 'Partial') + ' model review · '
          + Object.values(analysis.coverage ?? {}).filter(status => status === 'reviewed').length.toLocaleString() + ' files reviewed'
        : 'Loading review coverage…'}</p>
        {manifest.scope && <p>Directory scope <code>{manifest.scope}</code></p>}
      </div>
    </div>
  </details>
}

export function PriorReview({ review, manifest, onOpen }: {
  review: Review; manifest: Manifest | null; onOpen: (item: Evidence) => void
}) {
  const [filter, setFilter] = useState('')
  const changes = review.changes ?? review.changedPaths.map(path => ({
    path, kind: manifest?.files[path] ? 'modified' : 'deleted', baseline: review.baseline ?? undefined,
  }))
  const selected = changes.filter(item => item.path.toLowerCase().includes(filter.toLowerCase()))
  return <details className="review-strip">
    <summary><GitCompareArrows size={16}/> Changes since review
      <span>{review.changedPaths.length} changed · {review.affectedPaths.length} affected</span>
    </summary>
    <div className="review-details">
      {review.wideReview && <p>The change spans a large part of the repository. Review the affected scopes before recording a baseline.</p>}
      {review.uncertainSymbols?.length ? <p>{review.uncertainSymbols.length} possible symbol matches need review.</p> : null}
      {!!changes.length && <div className="input-icon"><Search size={16}/>
        <input aria-label="Filter changed files" placeholder="Filter changed files" value={filter} onChange={event => setFilter(event.target.value)}/></div>}
      <div className="changed-files">
        {selected.slice(0, 40).map(item => <div key={item.path} className="changed-file">
          <FileCode size={14}/><span title={item.path}>{item.path}</span>
          <small>{item.kind}</small>
          {manifest?.files[item.path]?.text && <button type="button" className="quiet" onClick={() => onOpen({
            kind: 'source', path: item.path, start: 1,
          })}>Current</button>}
          {item.baseline && item.kind !== 'added' && <button type="button" className="quiet" onClick={() => onOpen({
            kind: 'source', snapshotId: item.baseline, path: 'previousPath' in item && item.previousPath ? item.previousPath : item.path, start: 1,
          })}>Previous</button>}
        </div>)}
      </div>
      {selected.length > 40 && <p>Showing 40 of {selected.length} files. Filter by path to find others.</p>}
      {!changes.length && <p>No source changes in the reviewed scopes.</p>}
      {review.priorClaims.map(claim => <ClaimEntry key={claim.claimId} claim={claim} onOpen={onOpen}/>)}
    </div>
  </details>
}

export function ClaimEntry({ claim, onOpen }: { claim: Claim; onOpen: (item: Evidence) => void }) {
  return <article className="context-entry">
    <strong>{claim.statement}</strong><p>Confirmed by {claim.speaker} · {claim.scopes.join(', ')}</p>
    <EvidenceLinks items={claim.evidence} onOpen={onOpen}/>
  </article>
}
