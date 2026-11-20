import { useEffect } from 'react'
import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import {
  Background, BackgroundVariant, Handle, MarkerType, Position, ReactFlow,
  useNodesInitialized, useReactFlow, useStore,
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

export function componentNode(id: string, position: XYPosition, data: ComponentData, compact = false): ArchitectureNode {
  const width = compact ? 152 : data.role ? 190 : 172
  const height = compact ? 41 : data.role ? 59 : 49
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
    markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--graph-line)', width: 15, height: 15 },
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
const exampleFit: FitViewOptions = { padding: { x: '16px', y: '21px' }, maxZoom: 1.03 }
export const workspaceFit: FitViewOptions = { padding: { x: '22px', y: '30px' }, maxZoom: 1.2 }

function FitVisibleGraph({ focus, options }: { focus?: string; options: FitViewOptions }) {
  const { fitView, viewportInitialized } = useReactFlow()
  const initialized = useNodesInitialized()
  const width = useStore(store => store.width)
  const height = useStore(store => store.height)
  useEffect(() => {
    if (!initialized || !viewportInitialized || !width || !height) return
    const frame = requestAnimationFrame(() => { void fitView(options) })
    return () => cancelAnimationFrame(frame)
  }, [initialized, viewportInitialized, width, height, focus, fitView, options])
  return null
}

export function ArchitectureFlow({ id, label, nodes, edges, focus, compact = false, children }: {
  id: string
  label: string
  nodes: ArchitectureNode[]
  edges: ArchitectureEdge[]
  focus?: string
  compact?: boolean
  children?: ReactNode
}) {
  const fitOptions = compact ? exampleFit : workspaceFit
  return (
    <ReactFlow<ArchitectureNode, ArchitectureEdge>
      id={id} aria-label={label} className="architecture-flow"
      nodes={nodes} edges={edges} nodeTypes={nodeTypes} colorMode="dark"
      width={compact ? 580 : 800} height={compact ? 246 : 325}
      fitView fitViewOptions={fitOptions} minZoom={minimumZoom} maxZoom={maximumZoom}
      nodesConnectable={false} nodesDraggable={false} nodesFocusable={false}
      edgesReconnectable={false} deleteKeyCode={null}
      zoomOnDoubleClick={false} zoomOnScroll={false} preventScrolling={false}
      panOnDrag={!compact} zoomOnPinch={!compact}
      attributionPosition="top-right"
      onEdgeClick={(_, edge) => edge.data?.inspect()}
    >
      <Background id={id + '-grid'} variant={BackgroundVariant.Dots} gap={17} size={1} color="#4a4a58"/>
      <FitVisibleGraph focus={focus} options={fitOptions}/>
      {children}
    </ReactFlow>
  )
}
