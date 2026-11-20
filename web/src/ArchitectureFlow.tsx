import { useEffect } from 'react'
import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import {
  Background, BackgroundVariant, getNodesBounds, getViewportForBounds, Handle, MarkerType, Position, ReactFlow,
  useReactFlow, useStore,
} from '@xyflow/react'
import type { Edge, FitViewOptions, Node, NodeProps, XYPosition } from '@xyflow/react'
import type { DiagramRole } from '@/lib/architecture'
import { cn } from '@/lib/utils'

type ComponentData = {
  label: string
  subtitle?: string
  icon?: LucideIcon
  active?: boolean
  confirmed?: boolean
  role?: DiagramRole
  inspect: () => void
  center?: () => void
}

export type ArchitectureNode = Node<ComponentData, 'component'>
type ArchitectureEdge = Edge<{ inspect: () => void }>

const positions = [Position.Left, Position.Right, Position.Top, Position.Bottom]
const handleTypes = ['target', 'source'] as const
const ports = positions.flatMap(position => handleTypes.map(type => ({ id: type + '-' + position, position, type })))
const minimumZoom = 0.32
const maximumZoom = 1.85

export function componentNode(id: string, position: XYPosition, data: ComponentData): ArchitectureNode {
  const width = data.role === 'decision' ? 222 : data.role ? 190 : 172
  const height = data.role === 'decision' ? 68 : data.role ? 59 : 49
  const handles = ports.map(port => ({
    ...port, width: 2, height: 2,
    x: port.position === Position.Left ? 0 : port.position === Position.Right ? width - 2 : width / 2 - 1,
    y: port.position === Position.Top ? 0 : port.position === Position.Bottom ? height - 2 : height / 2 - 1,
  }))
  return { id, type: 'component', position, data, width, height, handles, selectable: false }
}

export function componentConnection({
  id, source, target, label, origin, active, inspect,
}: {
  id: string
  source: ArchitectureNode
  target: ArchitectureNode
  label: string
  origin?: string
  active?: boolean
  inspect: () => void
}): ArchitectureEdge {
  const { x, y } = source.position
  const { x: nextX, y: nextY } = target.position
  let sourceSide = Position.Right
  let targetSide = Position.Left
  if (x === nextX) {
    sourceSide = nextY > y ? Position.Bottom : Position.Top
    targetSide = nextY > y ? Position.Top : Position.Bottom
  } else if (x > nextX) {
    sourceSide = Position.Left
    targetSide = Position.Right
  }
  return {
    id, source: source.id, target: target.id,
    sourceHandle: 'source-' + sourceSide, targetHandle: 'target-' + targetSide,
    type: 'default', selectable: false, ariaRole: 'button', ariaLabel: label,
    markerEnd: { type: MarkerType.ArrowClosed, color: origin === 'decision' || origin === 'interview'
      ? 'var(--graph-confirmed)' : 'var(--graph-line)', width: 15, height: 15 },
    className: cn('architecture-edge', origin, active && 'active'),
    data: { inspect },
    domAttributes: {
      'aria-pressed': !!active,
      onKeyDown: event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          inspect()
        }
      },
    },
  }
}

function Component({ data }: NodeProps<ArchitectureNode>) {
  const Icon = data.icon
  return (
    <button type="button" className="architecture-node nopan nodrag" data-role={data.role}
      data-confirmed={data.confirmed || undefined} aria-label={data.label}
      aria-pressed={!!data.active} title={data.subtitle ? data.label + ' · ' + data.subtitle : data.label}
      onClick={data.inspect} onDoubleClick={data.center}>
      {Icon ? <Icon aria-hidden="true" size={15}/> : <span aria-hidden="true" className={cn('node-dot', data.confirmed && 'confirmed')}/>}
      <span className="node-label">
        <span>{data.label}</span>
        {data.subtitle && <small>{data.subtitle}</small>}
      </span>
      {ports.map(port => <Handle key={port.id} {...port} className="architecture-handle" isConnectable={false}/>)}
    </button>
  )
}

const nodeTypes = { component: Component }
export const workspaceFit = { padding: { x: '22px', y: '30px' }, maxZoom: 1.2 } satisfies FitViewOptions

function FitVisibleGraph({ focus, nodes }: { focus?: string; nodes: ArchitectureNode[] }) {
  const { setViewport, viewportInitialized } = useReactFlow()
  const width = useStore(store => store.width)
  const height = useStore(store => store.height)
  const { x, y, width: contentWidth, height: contentHeight } = getNodesBounds(nodes)
  useEffect(() => {
    if (!viewportInitialized || !width || !height || !contentWidth || !contentHeight) return
    void setViewport(getViewportForBounds({ x, y, width: contentWidth, height: contentHeight },
      width, height, minimumZoom, workspaceFit.maxZoom, workspaceFit.padding))
  }, [viewportInitialized, width, height, focus, setViewport, x, y, contentWidth, contentHeight])
  return null
}

export function ArchitectureFlow({ id, label, nodes, edges, focus, children }: {
  id: string
  label: string
  nodes: ArchitectureNode[]
  edges: ArchitectureEdge[]
  focus?: string
  children?: ReactNode
}) {
  return (
    <ReactFlow<ArchitectureNode, ArchitectureEdge>
      id={id} aria-label={label} className="architecture-flow"
      nodes={nodes} edges={edges} nodeTypes={nodeTypes} colorMode="dark"
      width={800} height={325}
      fitView fitViewOptions={workspaceFit} minZoom={minimumZoom} maxZoom={maximumZoom}
      nodesConnectable={false} nodesDraggable={false} nodesFocusable={false}
      edgesReconnectable={false} deleteKeyCode={null}
      zoomOnDoubleClick={false} zoomOnScroll={false} preventScrolling={false}
      attributionPosition="top-right"
      onEdgeClick={(_, edge) => edge.data?.inspect()}
    >
      <Background id={id + '-grid'} variant={BackgroundVariant.Dots} gap={17} size={1} color="#4a4a58"/>
      <FitVisibleGraph focus={focus} nodes={nodes}/>
      {children}
    </ReactFlow>
  )
}
