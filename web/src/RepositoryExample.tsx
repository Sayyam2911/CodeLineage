import { useState } from 'react'
import type { MouseEvent } from 'react'
import { ArrowRight, ArrowUpRight, AudioLines, Code2, GitFork, Github } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Diagram } from './Diagram'
import { SourceExcerpt } from './SourceExcerpt'
import type { Edge, Evidence, Excerpt, Graph, Node, Topic } from './api'

const commit = '51a503531d845fc11d5ef270d576c59c300e3620'
const models = 'hc/api/models.py'
const dispatcher = 'hc/api/management/commands/sendalerts.py'
const repository = 'https://github.com/healthchecks/healthchecks'
const snapshotId = 'healthchecks-demo'

function pinned(path: string, first: number, source: string[], start: number, end = start): Excerpt {
  return {
    path, commit, highlight: { start, end },
    url: repository + '/blob/' + commit + '/' + path + '#L' + start + '-L' + end,
    lines: source.map((text, offset) => ({ number: first + offset, text })),
  }
}

const samples = [
  {
    id: 'select', label: 'Select alert channels',
    excerpt: pinned(models, 1404, [
      '        if self.new_status not in ("up", "down"):',
      '            raise NotImplementedError(f"Unexpected status: {self.new_status}")',
      '',
      '        q = self.owner.channel_set.exclude(disabled=True)',
      '        q = q.order_by(F("last_notify_duration").asc(nulls_last=True))',
      '        return [ch for ch in q if not ch.transport.is_noop(self.new_status)]',
    ], 1407, 1409),
  },
  {
    id: 'dispatch', label: 'Dispatch an alert',
    excerpt: pinned(dispatcher, 32, [
      '    # Set or clear dates for followup nags',
      '    check = flip.owner',
      '    check.project.update_next_nag_dates()',
      '    channels = flip.select_channels()',
      '    if not channels:',
      '        return None',
    ], 35),
  },
  {
    id: 'duration', label: 'Record delivery time',
    excerpt: pinned(models, 1179, [
      '        Notification.objects.filter(id=n.id).update(error=error)',
      '        Channel.objects.filter(id=self.id).update(',
      '            last_notify=start,',
      '            last_notify_duration=now() - start,',
      '            last_error=error,',
      '            disabled=disabled,',
      '        )',
    ], 1182),
  },
  {
    id: 'notify', label: 'Notify each channel',
    excerpt: pinned(dispatcher, 39, [
      '    send_start = now()',
      '    logs = [f"{check.code} goes {flip.new_status}"]',
      '    for ch in channels:',
      '        notify_start = time.time()',
      '        error = ch.notify(flip)',
      '        secs = time.time() - notify_start',
    ], 41, 43),
  },
]

const graph: Graph = {
  snapshotId, revision: 0, claims: [],
  nodes: samples.map(({ id, label, excerpt }) => ({
    id, label, origin: 'extracted', path: excerpt.path, start: excerpt.highlight.start, end: excerpt.highlight.end,
  })),
  edges: [
    { source: 'dispatch', target: 'select', relation: 'calls', origin: 'extracted', path: dispatcher, start: 35 },
    { source: 'duration', target: 'select', relation: 'informs order', origin: 'inferred', path: models, start: 1182 },
    { source: 'select', target: 'notify', relation: 'supplies channels', origin: 'extracted', path: dispatcher, start: 41 },
  ],
}

const topic: Topic = {
  id: 'delivery-order', origin: 'code', title: 'Alert delivery order',
  question: 'What trade-off does your deployment accept when a new channel has no delivery history?',
  statement: '', targetId: 'select', scope: models,
  evidence: [samples[0], samples[2]].map(({ excerpt }) => ({
    kind: 'source', path: excerpt.path, start: excerpt.highlight.start, end: excerpt.highlight.end,
  })),
}

export function RepositoryExample({ onOpen }: { onOpen: (event: MouseEvent<HTMLButtonElement>) => void }) {
  const [selected, setSelected] = useState(samples[0])
  const [edge, setEdge] = useState<Edge | null>(null)

  function openSource(ref: Pick<Evidence, 'path' | 'start'>) {
    const sample = samples.find(({ excerpt }) => excerpt.path === ref.path && excerpt.highlight.start === ref.start)
    if (sample) setSelected(sample)
  }

  function openNode(node: Node) {
    openSource(node)
    setEdge(null)
  }

  function openEdge(connection: Edge) {
    if (connection.path) openSource({ path: connection.path, start: connection.start ?? undefined })
    setEdge(connection)
  }

  return (
    <section id="architecture-demo" className="example-repo" aria-labelledby="example-heading">
      <header className="example-heading">
        <div className="example-info">
          <span className="example-logo"><Github aria-hidden="true" size={17}/></span>
          <div>
            <h2 id="example-heading">Healthchecks</h2>
            <p>Alert delivery walkthrough</p>
          </div>
        </div>
        <Button type="button" size="sm" variant="outline" onClick={onOpen}>
          Try this review <ArrowRight aria-hidden="true"/>
        </Button>
      </header>
      <div className="panels example-panels">
        <section className="editor-panel" aria-labelledby="example-architecture">
          <header className="panel-heading">
            <GitFork aria-hidden="true" size={17}/><h3 id="example-architecture">Architecture</h3>
          </header>
          <Diagram graph={graph} manifest={null} anchor={selected.id} selected={selected.id} selectedEdge={edge}
            excerpt={selected.excerpt} topic={topic} onEdge={openEdge} onSelect={openNode}
            onSource={openSource} onAnchor={id => {
              const node = graph.nodes.find(item => item.id === id)
              if (node) openNode(node)
            }}/>
        </section>
        <section className="editor-panel source-panel" aria-labelledby="example-source">
          <header className="panel-heading">
            <Code2 aria-hidden="true" size={17}/><h3 id="example-source">Source evidence</h3>
            <Button asChild variant="ghost" size="sm">
              <a href={selected.excerpt.url} target="_blank" rel="noreferrer" aria-label="Open pinned source on GitHub">
                GitHub <ArrowUpRight aria-hidden="true"/>
              </a>
            </Button>
          </header>
          <SourceExcerpt excerpt={selected.excerpt} previous={false}/>
        </section>
      </div>
      <div className="example-question">
        <AudioLines aria-hidden="true" size={21}/>
        <p>{topic.question}</p>
      </div>
    </section>
  )
}
