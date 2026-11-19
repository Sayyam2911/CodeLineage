import { useState } from 'react'
import { ArrowUpRight, FileCode2, GitBranch, GitFork, Layers3, Radio, Timer } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'

const commit = '51a503531d845fc11d5ef270d576c59c300e3620'
const file = 'hc/api/models.py'
const steps = [
  {
    id: 'status', name: 'Status change', icon: Radio, lines: [
      { number: 1401, text: 'if self.new_status == "up" and self.old_status in ("new", "paused"):' },
      { number: 1402, text: '    return []' },
    ],
  },
  {
    id: 'eligibility', name: 'Eligible channels', icon: Layers3, lines: [
      { number: 1407, text: 'q = self.owner.channel_set.exclude(disabled=True)' },
    ],
  },
  {
    id: 'ordering', name: 'Delivery order', icon: GitFork, lines: [
      { number: 1407, text: 'q = self.owner.channel_set.exclude(disabled=True)' },
      { number: 1408, text: 'q = q.order_by(F("last_notify_duration").asc(nulls_last=True))', marked: true },
      { number: 1409, text: 'return [ch for ch in q if not ch.transport.is_noop(self.new_status)]' },
    ],
  },
  {
    id: 'history', name: 'Delivery history', icon: Timer, lines: [
      { number: 1180, text: 'Channel.objects.filter(id=self.id).update(' },
      { number: 1181, text: '    last_notify=start,' },
      { number: 1182, text: '    last_notify_duration=now() - start,', marked: true },
      { number: 1183, text: '    last_error=error,' },
    ],
  },
]

export function RepositoryExample() {
  const [selected, setSelected] = useState('ordering')
  const step = steps.find(item => item.id === selected) ?? steps[2]
  const source = 'https://github.com/healthchecks/healthchecks/blob/' + commit + '/' + file
  const lineUrl = source + '#L' + step.lines[0].number + '-L' + step.lines[step.lines.length - 1].number

  return (
    <section className="example-repo" aria-labelledby="example-heading">
      <Tabs className="example-tabs" defaultValue="architecture">
        <div className="example-heading">
          <div className="example-info">
            <span className="example-logo"><GitBranch aria-hidden="true" size={17}/></span>
            <div>
              <h2 id="example-heading">Healthchecks</h2>
              <p>Alert delivery</p>
            </div>
          </div>
          <TabsList aria-label="Example view" className="example-tab-list">
            <TabsTrigger value="architecture">Architecture</TabsTrigger>
            <TabsTrigger value="source">Source</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="architecture" className="example-graph">
          <svg aria-hidden="true" className="example-connections" viewBox="0 0 600 252" preserveAspectRatio="none">
            <defs>
              <marker id="example-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M1 1 L6 4 L1 7" stroke="currentColor" fill="none"/>
              </marker>
            </defs>
            <path d="M160 113 H225" markerEnd="url(#example-arrow)"/>
            <path d="M369 113 H432" markerEnd="url(#example-arrow)"/>
            <path d="M515 212 V147" className="example-history-edge" markerEnd="url(#example-arrow)"/>
          </svg>
          {steps.map(({ id, name, icon: Icon }) => (
            <Button
              key={id}
              type="button"
              variant="outline"
              aria-pressed={selected === id}
              className={cn('example-node', 'example-node-' + id)}
              onClick={() => setSelected(id)}
            >
              <Icon aria-hidden="true"/>
              <span>{name}</span>
            </Button>
          ))}
        </TabsContent>

        <TabsContent value="source" className="example-source-full">
          {steps.map(item => (
            <button key={item.id} type="button" className="example-source-choice" aria-pressed={selected === item.id} onClick={() => setSelected(item.id)}>
              <item.icon aria-hidden="true" size={17}/>
              <span>{item.name}</span>
              <code>L{item.lines[0].number}</code>
            </button>
          ))}
        </TabsContent>

        <div className="example-evidence">
          <div className="example-evidence-bar">
            <span><FileCode2 aria-hidden="true" size={15}/><code>{file}</code></span>
            <div>
              <Badge variant="outline" className="commit-tag">{commit.slice(0, 7)}</Badge>
              <Button asChild variant="ghost" size="icon-sm">
                <a href={lineUrl} target="_blank" rel="noreferrer" aria-label={'Open ' + step.name.toLowerCase() + ' on GitHub'}>
                  <ArrowUpRight aria-hidden="true"/>
                </a>
              </Button>
            </div>
          </div>
          <div className="example-code" tabIndex={0} role="region" aria-label="Pinned Healthchecks source">
            {step.lines.map(({ number, text, marked }) => (
              <div key={number} className={cn('example-code-row', marked && 'example-code-marked')}>
                <span aria-hidden="true">{number}</span><code>{text}</code>
              </div>
            ))}
          </div>
        </div>
      </Tabs>
    </section>
  )
}
