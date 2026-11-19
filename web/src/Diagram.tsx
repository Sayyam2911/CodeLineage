import { useMemo, useState } from 'react'
import { Box, Crosshair, GitFork, Minus, Plus } from 'lucide-react'
import type { Edge, Graph, Node } from './api'

const SIZE = { width: 172, height: 47 }
type Positioned = { node: Node; x: number; y: number }

function layout(graph: Graph, anchor: string | null, selected: string | null): Positioned[] {
  const nodes = new Map(graph.nodes.map(node => [node.id, node]))
  const focus = nodes.get(anchor ?? '') ?? graph.nodes[0]
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
  if (sides.every(side => !side.length)) sides[1] = sameFile.length ? sameFile : graph.nodes.filter(node => !used.has(node.id)).slice(0, 4)
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

export function Diagram({ graph, anchor, selected, onSelect, onAnchor }: {
  graph: Graph
  anchor: string | null
  selected: string | null
  onSelect: (node: Node) => void
  onAnchor: (id: string) => void
}) {
  const [zoom, setZoom] = useState(1)
  const positioned = useMemo(() => layout(graph, anchor, selected), [graph, anchor, selected])
  const point = new Map(positioned.map(item => [item.node.id, item]))
  if (!positioned.length) return <div className="panel-empty"><GitFork size={25}/><p>No structural symbols in this scope. Source files are still available.</p></div>
  return <div className="diagram">
    <div className="canvas">
      <svg role="img" aria-label="Directed architecture diagram" viewBox="0 0 700 375">
        <defs><marker id="arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0 0 L6 3 L0 6 Z" fill="#657988"/></marker></defs>
        <g transform={'translate(350 187) scale(' + zoom + ') translate(-350 -187)'}>
          {graph.edges.map((edge, index) => {
            const from = point.get(edge.source)
            const to = point.get(edge.target)
            if (!from || !to || from === to) return null
            const rightward = from.x < to.x
            const x1 = from.x + (rightward ? SIZE.width : 0), x2 = to.x + (rightward ? 0 : SIZE.width)
            const y1 = from.y + SIZE.height / 2, y2 = to.y + SIZE.height / 2
            const mid = (x1 + x2) / 2
            return <path key={index} d={'M' + x1 + ' ' + y1 + ' C' + mid + ' ' + y1 + ' ' + mid + ' ' + y2 + ' ' + x2 + ' ' + y2}
              className={'edge ' + edge.origin} markerEnd="url(#arrow)"><title>{edge.relation} · {edge.origin}</title></path>
          })}
          {positioned.map(({ node, x, y }) => {
            const active = node.id === selected
            const confirmed = graph.claims.some(claim => claim.targetId === node.id && claim.snapshotId === graph.snapshotId)
            return <g key={node.id} role="button" aria-label={node.label} aria-pressed={active} tabIndex={0}
              onClick={() => onSelect(node)}
              onDoubleClick={() => onAnchor(node.id)}
              onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(node) } }}
              className={'graph-node ' + (active ? 'selected' : '')} transform={'translate(' + x + ' ' + y + ')'}>
              <rect width={SIZE.width} height={SIZE.height} rx={8}/>
              <circle cx="15" cy="17" r="3" className={confirmed ? 'confirmed' : ''}/>
              <text x="26" y="21">{node.label.length > 21 ? node.label.slice(0, 20) + '…' : node.label}</text>
              <text x="26" y="35" className="node-path">{node.path?.split('/').at(-1)?.slice(0, 21) ?? 'Interview confirmed'}</text>
              <title>{node.label}{node.path ? ' · ' + node.path : ''}</title>
            </g>
          })}
        </g>
      </svg>
    </div>
    <div className="diagram-tools">
      <button type="button" title="Center on selection" aria-label="Center on selection" disabled={!selected}
        onClick={() => { if (selected) onAnchor(selected); setZoom(1) }}><Crosshair size={16}/></button>
      <button type="button" title="Zoom out" aria-label="Zoom out" disabled={zoom <= 0.65}
        onClick={() => setZoom(value => Math.max(0.65, value - 0.15))}><Minus size={16}/></button>
      <button type="button" title="Zoom in" aria-label="Zoom in" disabled={zoom >= 1.45}
        onClick={() => setZoom(value => Math.min(1.45, value + 0.15))}><Plus size={16}/></button>
    </div>
    <div className="diagram-legend"><span><Box size={13}/> Extracted component</span><span><i/> Inferred connection</span></div>
  </div>
}
