import { useMemo, useState } from 'react'
import { Box, Crosshair, GitFork, Minus, Plus, Search } from 'lucide-react'
import { useReactFlow, useStore } from '@xyflow/react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ArchitectureFlow, componentConnection, componentNode, workspaceFit } from './ArchitectureFlow'
import type { Edge, Excerpt, Graph, Node } from './api'

type Positioned = { node: Node; x: number; y: number }

function componentForExcerpt(graph: Graph, excerpt: Excerpt | null) {
  const line = excerpt?.highlight?.start ?? excerpt?.lines[0]?.number
  if (!excerpt || line === undefined) return
  let preceding: Node | undefined
  for (const node of graph.nodes) {
    if (node.path !== excerpt.path || node.start == null || node.start > line) continue
    if (preceding?.start == null || node.start > preceding.start) preceding = node
  }
  if (!preceding) return
  // When a docstring is the nearest extracted item, focus its owning symbol.
  return graph.edges.find(edge => edge.relation === 'rationale_for' && edge.source === preceding.id)?.target
    ?? preceding.id
}

function layout(graph: Graph, anchor: string | null, selected: string | null, excerpt: Excerpt | null): Positioned[] {
  const nodes = new Map(graph.nodes.map(node => [node.id, node]))
  const anchored = nodes.get(anchor ?? '')
  const focus = excerpt
    ? (anchored?.path === excerpt.path ? anchored : nodes.get(componentForExcerpt(graph, excerpt) ?? ''))
    : anchored ?? graph.nodes[0]
  if (!focus) return []
  const neighbors = (edges: Edge[], key: 'source' | 'target', other: 'source' | 'target') =>
    [...new Set(edges.filter(edge => edge[key] === focus.id && edge[other] !== focus.id).map(edge => edge[other]))]
      .map(id => nodes.get(id)).filter((node): node is Node => !!node)
  const incoming = neighbors(graph.edges, 'target', 'source').slice(0, 4)
  const added = graph.nodes.filter(node => node.origin === 'interview' && node.id !== focus.id)
  const outgoing = [...new Map([...neighbors(graph.edges, 'source', 'target'), ...added]
    .filter(node => !incoming.some(left => left.id === node.id)).map(node => [node.id, node])).values()].slice(0, 4)
  const used = new Set([focus.id, ...incoming.map(node => node.id), ...outgoing.map(node => node.id)])
  const sameFile = graph.nodes.filter(node => node.path === focus.path && !used.has(node.id)).slice(0, 4)
  const sides = [incoming, outgoing]
  if (sides.every(side => !side.length)) {
    sides[1] = !sameFile.length && !excerpt ? graph.nodes.filter(node => !used.has(node.id)).slice(0, 4) : sameFile
  }
  const visible = new Set([focus.id, ...sides.flat().map(node => node.id)])
  const latest = graph.claims.find(claim => claim.snapshotId === graph.snapshotId && claim.revision === graph.revision)
  const additional = [...new Set([selected, latest?.relatedId])]
    .flatMap(id => id && !visible.has(id) && nodes.has(id) ? [nodes.get(id)!] : [])
  return [
    { node: focus, x: 262, y: 165 },
    ...additional.map((node, index) => ({ node, x: 262, y: [280, 64][index] })),
    ...sides.flatMap((side, column) => side.map((node, index) => ({
      node,
      x: column === 0 ? 34 : 492,
      y: [165, 93, 237, 21][index],
    }))),
  ]
}

function DiagramControls({ center }: { center?: () => void }) {
  const { fitView, zoomIn, zoomOut } = useReactFlow()
  const canZoomIn = useStore(store => store.transform[2] < store.maxZoom)
  const canZoomOut = useStore(store => store.transform[2] > store.minZoom)
  const centerLabel = center ? 'Center on selection' : 'Fit diagram'

  return <div className="diagram-tools">
    <Tooltip>
      <TooltipTrigger asChild><Button type="button" variant="ghost" size="icon-sm" aria-label={centerLabel}
        onClick={() => { center?.(); void fitView(workspaceFit) }}>
        <Crosshair aria-hidden="true"/>
      </Button></TooltipTrigger>
      <TooltipContent>{centerLabel}</TooltipContent>
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

export function Diagram({ graph, anchor, selected, selectedEdge, excerpt, onSelect, onEdge, onAnchor }: {
  graph: Graph
  anchor: string | null
  selected: string | null
  selectedEdge: Edge | null
  excerpt: Excerpt | null
  onEdge: (edge: Edge) => void
  onSelect: (node: Node) => void
  onAnchor: (id: string) => void
}) {
  const [search, setSearch] = useState('')
  const matches = useMemo(() => {
    const term = search.trim().toLowerCase()
    if (!term) return []
    return graph.nodes.filter(node => [node.label, node.path ?? ''].some(text => text.toLowerCase().includes(term))).slice(0, 12)
  }, [graph.nodes, search])
  const positioned = useMemo(() => layout(graph, anchor, selected, excerpt), [graph, anchor, selected, excerpt])
  const connections = useMemo(() => {
    const visible = new Set(positioned.map(({ node }) => node.id))
    return graph.edges.filter(edge => edge.source !== edge.target && visible.has(edge.source) && visible.has(edge.target))
  }, [graph.edges, positioned])
  const focus = positioned[0]?.node.id
  const confirmed = new Set(graph.claims.filter(claim => claim.snapshotId === graph.snapshotId).map(claim => claim.targetId))
  const nodes = positioned.map(({ node, x, y }) => componentNode(node.id, { x, y }, {
    label: node.label,
    subtitle: node.path?.split('/').at(-1) ?? 'Interview confirmed',
    active: node.id === (selected ?? focus),
    confirmed: confirmed.has(node.id),
    inspect: () => onSelect(node),
    center: () => onAnchor(node.id),
  }))
  const byId = new Map(nodes.map(node => [node.id, node]))
  const edges = connections.map((edge, index) => componentConnection({
    id: edge.id ?? edge.source + '-' + edge.target + '-' + index,
    source: byId.get(edge.source)!,
    target: byId.get(edge.target)!,
    label: byId.get(edge.source)!.data.label + ' ' + edge.relation + ' ' + byId.get(edge.target)!.data.label,
    origin: edge.origin,
    active: edge === selectedEdge,
    inspect: () => onEdge(edge),
  }))
  return <div className="diagram">
    <div className="diagram-search">
      <div className="diagram-search-field"><Search size={15} aria-hidden="true"/><Input aria-label="Find a component" placeholder="Find a component or path…"
        type="search" spellCheck={false} autoComplete="off"
        value={search} onChange={event => setSearch(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Escape') setSearch('')
          if (event.key === 'Enter' && matches[0]) { onAnchor(matches[0].id); onSelect(matches[0]); setSearch('') }
        }}/></div>
      {search.trim() && <div className="component-results">
        {matches.length ? matches.map(node => <Button key={node.id} type="button" variant="ghost" onClick={() => {
          onAnchor(node.id); onSelect(node); setSearch('')
        }}><strong>{node.label}</strong><small>{node.path}</small></Button>) : <p>No matching components.</p>}
      </div>}
      <span>{graph.nodes.length.toLocaleString()} components</span>
    </div>
    {focus ? <div className="canvas">
      <ArchitectureFlow id="review-architecture" label="Directed architecture diagram"
        nodes={nodes} edges={edges} focus={graph.revision + ':' + focus}>
        <DiagramControls center={selected ? () => onAnchor(selected) : undefined}/>
        <div className="diagram-legend"><span><Box size={13} aria-hidden="true"/> Extracted component</span><span><i/> Inferred connection</span></div>
      </ArchitectureFlow>
    </div> : <div className="panel-empty">
      <GitFork size={25} aria-hidden="true"/>
      <p>{excerpt ? 'No extracted component covers this source excerpt.' : 'No structural symbols in this scope.'}</p>
    </div>}
  </div>
}
