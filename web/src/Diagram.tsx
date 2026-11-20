import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Box, Crosshair, FileCode2, Folder, GitFork, MessagesSquare, Minus, Plus, Search } from 'lucide-react'
import { useReactFlow, useStore } from '@xyflow/react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { focusedStructure, repositoryStructure } from '@/lib/architecture'
import { ArchitectureFlow, componentConnection, componentNode, workspaceFit } from './ArchitectureFlow'
import type { Edge, Evidence, Excerpt, Graph, Manifest, Node, Topic } from './api'

function DiagramControls() {
  const { fitView, zoomIn, zoomOut } = useReactFlow()
  const canZoomIn = useStore(store => store.transform[2] < store.maxZoom)
  const canZoomOut = useStore(store => store.transform[2] > store.minZoom)

  return <div className="diagram-tools">
    <Tooltip>
      <TooltipTrigger asChild><Button type="button" variant="ghost" size="icon-sm" aria-label="Fit diagram"
        onClick={() => void fitView(workspaceFit)}>
        <Crosshair aria-hidden="true"/>
      </Button></TooltipTrigger>
      <TooltipContent>Fit diagram</TooltipContent>
    </Tooltip>
    <Separator orientation="vertical"/>
    <Tooltip>
      <TooltipTrigger asChild><Button type="button" variant="ghost" size="icon-sm" aria-label="Zoom out" disabled={!canZoomOut}
        onClick={() => void zoomOut()}><Minus aria-hidden="true"/></Button></TooltipTrigger>
      <TooltipContent>Zoom out</TooltipContent>
    </Tooltip>
    <Tooltip>
      <TooltipTrigger asChild><Button type="button" variant="ghost" size="icon-sm" aria-label="Zoom in" disabled={!canZoomIn}
        onClick={() => void zoomIn()}><Plus aria-hidden="true"/></Button></TooltipTrigger>
      <TooltipContent>Zoom in</TooltipContent>
    </Tooltip>
  </div>
}

export function Diagram({ graph, manifest, anchor, selected, selectedEdge, excerpt, topic, onSelect, onSource, onEdge, onAnchor }: {
  graph: Graph
  manifest: Manifest | null
  anchor: string | null
  selected: string | null
  selectedEdge: Edge | null
  excerpt: Excerpt | null
  topic?: Topic
  onEdge: (edge: Edge) => void
  onSelect: (node: Node) => void
  onSource: (source: Evidence) => void
  onAnchor: (id: string) => void
}) {
  const [repositoryViewFor, setRepositoryViewFor] = useState<Excerpt | null | undefined>()
  const [directory, setDirectory] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [narrow, setNarrow] = useState(false)
  const diagram = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!diagram.current) return
    const observer = new ResizeObserver(([entry]) => setNarrow(entry.contentRect.width < 540))
    observer.observe(diagram.current)
    return () => observer.disconnect()
  }, [])

  const matches = useMemo(() => {
    const term = search.trim().toLowerCase()
    if (!term) return []
    return graph.nodes.filter(node => [node.label, node.path ?? ''].some(text => text.toLowerCase().includes(term))).slice(0, 12)
  }, [graph.nodes, search])
  const focused = useMemo(() => focusedStructure(graph, excerpt, anchor, selected, topic, narrow),
    [graph, excerpt, anchor, selected, topic, narrow])
  const overview = repositoryViewFor === excerpt || !focused
  const structure = useMemo(() => overview ? repositoryStructure(graph, manifest, directory, narrow) : focused!,
    [overview, graph, manifest, directory, narrow, focused])
  const confirmed = new Set(graph.claims.filter(claim => claim.snapshotId === graph.snapshotId).map(claim => claim.targetId))
  const nodes = structure.items.map(item => componentNode(item.id, { x: item.x, y: item.y }, {
    label: item.label,
    subtitle: item.subtitle,
    role: item.role,
    icon: item.role === 'directory' ? Folder : item.role === 'source' ? FileCode2
      : item.role === 'topic' ? MessagesSquare : Box,
    active: item.role === 'focus' || item.role === 'source' && !overview,
    confirmed: confirmed.has(item.id),
    inspect: () => {
      if (item.directory !== undefined) setDirectory(item.directory)
      else if (item.source) {
        setRepositoryViewFor(undefined)
        onSource(item.source)
      } else if (item.node) onSelect(item.node)
    },
    center: item.node ? () => onAnchor(item.node!.id) : undefined,
  }))
  const byId = new Map(nodes.map(node => [node.id, node]))
  const edges = structure.links.map(link => componentConnection({
    id: link.source + ':' + link.target,
    source: byId.get(link.source)!,
    target: byId.get(link.target)!,
    label: byId.get(link.source)!.data.label + ' · ' + link.label + ' · ' + byId.get(link.target)!.data.label,
    origin: link.origin,
    active: link.evidence === selectedEdge,
    inspect: () => {
      if (link.evidence) onEdge(link.evidence)
      else if (excerpt) onSource({ kind: 'source', path: excerpt.path,
        start: excerpt.highlight?.start ?? excerpt.lines[0]?.number, end: excerpt.highlight?.end })
    },
  }))
  function choose(node: Node) {
    setRepositoryViewFor(undefined); setSearch(''); onAnchor(node.id); onSelect(node)
  }
  return <div className="diagram" ref={diagram}>
    <div className="diagram-search">
      <div className="diagram-search-field"><Search size={15} aria-hidden="true"/><Input aria-label="Find a component" placeholder="Find a component or path…"
        type="search" spellCheck={false} autoComplete="off"
        value={search} onChange={event => setSearch(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Escape') setSearch('')
          if (event.key === 'Enter' && matches[0]) choose(matches[0])
        }}/></div>
      {search.trim() && <div className="component-results">
        {matches.length ? matches.map(node => <Button key={node.id} type="button" variant="ghost"
          onClick={() => choose(node)}><strong>{node.label}</strong><small>{node.path}</small></Button>)
          : <p>No matching components.</p>}
      </div>}
      <div className="diagram-modes" role="group" aria-label="Diagram view">
        <Button size="sm" variant={overview ? 'ghost' : 'secondary'} type="button" aria-pressed={!overview}
          disabled={!focused} onClick={() => setRepositoryViewFor(undefined)}>Focus</Button>
        <Button size="sm" variant={overview ? 'secondary' : 'ghost'} type="button" aria-pressed={overview}
          onClick={() => { setDirectory(null); setRepositoryViewFor(excerpt) }}>Repository</Button>
      </div>
    </div>
    <div className="diagram-context">
      {overview && directory !== null && <Button variant="ghost" size="icon-sm" type="button" aria-label="Back to folders"
        onClick={() => setDirectory(null)}><ArrowLeft aria-hidden="true"/></Button>}
      <strong title={structure.title}>{structure.title}</strong><span>{structure.description}</span>
    </div>
    {nodes.length ? <div className="canvas">
      <ArchitectureFlow id="review-architecture" label={overview ? 'Repository structure' : 'Evidence and related components'}
        nodes={nodes} edges={edges} focus={graph.revision + ':' + overview + ':' + nodes.map(node => node.id).join(':')}>
        <DiagramControls/>
        <div className="diagram-legend">
          {structure.links.some(link => link.origin === 'citation') ? <span><i className="citation"/> Cited by topic</span> : <>
            {structure.links.some(link => link.origin !== 'inferred') && <span><i className="observed"/> Recorded relationship</span>}
            {structure.links.some(link => link.origin === 'inferred') && <span><i/> Inferred relationship</span>}
          </>}
        </div>
      </ArchitectureFlow>
    </div> : <div className="panel-empty">
      <GitFork size={25} aria-hidden="true"/>
      <p>No source files in this scope.</p>
    </div>}
  </div>
}
