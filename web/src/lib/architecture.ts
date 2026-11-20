import type { Claim, Edge, Evidence, Excerpt, Graph, Manifest, Node, Topic } from '../api'

export type DiagramRole = 'focus' | 'incoming' | 'outgoing' | 'source' | 'directory' | 'topic' | 'decision'
export type DiagramItem = {
  id: string
  label: string
  subtitle: string
  role: DiagramRole
  x: number
  y: number
  node?: Node
  source?: Evidence
  decision?: Claim
  directory?: string
}

export type DiagramLink = {
  source: string
  target: string
  label: string
  origin: string
  evidence?: Edge
  decision?: Claim
}

export type Structure = {
  items: DiagramItem[]
  links: DiagramLink[]
  title: string
  description: string
}

const filename = (path: string) => path.split('/').at(-1) ?? path
const directoryOf = (path: string) => path.includes('/') ? path.split('/')[0] : ''
const relation = (edge: Edge) => edge.relation.replaceAll('_', ' ')

export function decisionEvidence(claim: Claim) {
  const ref = claim.evidence.find(item => item.kind === 'source' && item.path && item.start)
    ?? claim.evidence.find(item => item.kind === 'document')
  return ref?.kind === 'source' && !ref.snapshotId ? { ...ref, snapshotId: claim.snapshotId } : ref
}

export function decisionStructure(graph: Graph, claim: Claim, narrow: boolean): Structure {
  const decision: DiagramItem = {
    id: 'decision:' + claim.claimId, label: claim.title, subtitle: 'Confirmed · Revision ' + claim.revision,
    role: 'decision', x: 0, y: 0, decision: claim,
  }
  const items = [decision]
  const links: DiagramLink[] = []
  const current = claim.snapshotId === graph.snapshotId
  const target = current ? graph.nodes.find(node => node.id === claim.targetId) : undefined
  const related = current && claim.operation === 'add_connection'
    ? graph.nodes.find(node => node.id === claim.relatedId) : undefined
  const ref = decisionEvidence(claim)
  const position = narrow ? { x: 0, y: 106 } : { x: 282, y: 5 }
  const subject: DiagramItem | undefined = target ? {
    ...position, id: target.id, label: target.label, subtitle: target.path ?? 'Interview component', role: 'focus', node: target,
  } : ref ? {
    ...position, id: 'evidence:' + claim.claimId, label: ref.path ? filename(ref.path) : ref.title ?? 'Source document',
    subtitle: ref.path ? ref.path + ' · L' + ref.start : 'Supporting document', role: 'source', source: ref,
  } : undefined
  if (subject) {
    items.push(subject)
    links.push({ source: decision.id, target: subject.id, label: target ? 'explains' : 'cites', origin: 'decision', decision: claim })
  }
  const connection = target && related ? graph.edges.find(edge =>
    edge.claimId === claim.claimId && edge.source === target.id && edge.target === related.id) : undefined
  if (connection && related) {
    if (related.id !== subject?.id) {
      items.push({ id: related.id, label: related.label, subtitle: related.path ?? 'Interview component', role: 'outgoing',
        x: narrow ? 0 : 532, y: narrow ? 201 : 5, node: related })
    }
    links.push({ source: connection.source, target: connection.target, label: relation(connection),
      origin: connection.origin, evidence: connection })
  }
  return { items, links, title: claim.title, description: 'Confirmed in interview · Revision ' + claim.revision }
}

function componentForExcerpt(graph: Graph, excerpt: Excerpt) {
  const line = excerpt.highlight?.start ?? excerpt.lines[0]?.number
  if (line === undefined) return
  let preceding: Node | undefined
  for (const node of graph.nodes) {
    if (node.path !== excerpt.path || node.start == null || node.start > line) continue
    if (preceding?.start == null || node.start > preceding.start) preceding = node
  }
  if (!preceding) return
  const owner = graph.edges.find(edge => edge.relation === 'rationale_for' && edge.source === preceding.id)
  return graph.nodes.find(node => node.id === owner?.target) ?? preceding
}

function citedFile(excerpt: Excerpt, topic: Topic | undefined): Structure {
  const start = excerpt.highlight?.start ?? excerpt.lines[0]?.number ?? 1
  const end = excerpt.highlight?.end ?? excerpt.lines.at(-1)?.number ?? start
  const source: Evidence = { kind: 'source', path: excerpt.path, start, end }
  const file: DiagramItem = {
    id: 'file:' + excerpt.path, label: filename(excerpt.path), subtitle: excerpt.path + ' · L' + start,
    role: 'source', x: 0, y: 0, source,
  }
  const fromTopic = topic?.evidence.some(ref => ref.kind === 'source' && ref.path === excerpt.path && ref.start === start)
  const items: DiagramItem[] = [file]
  const links: DiagramLink[] = []
  if (topic && fromTopic) {
    items.unshift({ id: 'topic:' + topic.id, label: topic.title, subtitle: 'Interview topic', role: 'topic',
      x: 0, y: 0, source })
    file.x = 258
    links.push({ source: items[0].id, target: file.id, label: 'cites', origin: 'citation' })
  }
  return { items, links, title: filename(excerpt.path), description: 'Pinned source · lines ' + start + '–' + end }
}

export function focusedStructure(
  graph: Graph, excerpt: Excerpt | null, anchor: string | null, selected: string | null,
  topic: Topic | undefined, narrow: boolean,
): Structure | null {
  const byId = new Map(graph.nodes.map(node => [node.id, node]))
  const anchored = byId.get(anchor ?? '')
  const focus = excerpt ? (anchored?.path === excerpt.path ? anchored : componentForExcerpt(graph, excerpt))
    : anchored ?? byId.get(selected ?? '')
  if (!focus) return excerpt ? citedFile(excerpt, topic) : null

  function neighbors(direction: 'incoming' | 'outgoing') {
    const unique = new Map<string, { node: Node; edge: Edge }>()
    for (const edge of graph.edges) {
      const nodeId = direction === 'incoming' && edge.target === focus?.id ? edge.source
        : direction === 'outgoing' && edge.source === focus?.id ? edge.target : undefined
      const node = nodeId ? byId.get(nodeId) : undefined
      if (!node || node.id === focus?.id) continue
      const key = (node.path ?? '') + '\0' + node.label
      const prior = unique.get(key)
      if (!prior || (prior.edge.origin === 'inferred' && edge.origin !== 'inferred')) unique.set(key, { node, edge })
    }
    return [...unique.values()].sort((left, right) =>
      Number(left.edge.origin === 'inferred') - Number(right.edge.origin === 'inferred')
      || Number(/\.(test|spec)\./.test(left.node.path ?? '')) - Number(/\.(test|spec)\./.test(right.node.path ?? '')))
  }

  const upstream = neighbors('incoming')
  const downstream = neighbors('outgoing')
  const limit = narrow ? 2 : 4
  const incoming = upstream.slice(0, limit)
  const outgoing = downstream.filter(item => !incoming.some(prior => prior.node.id === item.node.id)).slice(0, limit)
  const rowCount = Math.max(incoming.length, outgoing.length, 1)
  const centerY = (rowCount - 1) * 81 / 2
  const middle = narrow && incoming.length ? 101 : 0
  const itemFor = (node: Node, x: number, y: number, role: DiagramRole): DiagramItem => ({
    id: node.id, label: node.label, subtitle: node.path ?? 'Interview component', role, x, y, node,
  })
  const items = [itemFor(focus, narrow ? 111 : 247, narrow ? middle : centerY, 'focus')]
  for (const [position, group] of [incoming, outgoing].entries()) {
    group.forEach(({ node }, index) => {
      const x = narrow ? index * 222 + (group.length === 1 ? 111 : 0) : position * 494
      const y = narrow ? (position ? middle + 101 : 0) : (rowCount - group.length) * 81 / 2 + index * 81
      items.push(itemFor(node, x, y, position ? 'outgoing' : 'incoming'))
    })
  }
  const links = [...incoming, ...outgoing].map(({ edge }) => ({
    source: edge.source, target: edge.target, label: relation(edge), origin: edge.origin, evidence: edge,
  }))
  const directions = [upstream.length ? upstream.length + ' incoming' : '', downstream.length ? downstream.length + ' outgoing' : '']
    .filter(Boolean).join(' · ')
  return { items, links, title: focus.label, description: directions || focus.path || 'Reviewed component' }
}

export function repositoryStructure(graph: Graph, manifest: Manifest | null, directory: string | null, narrow: boolean): Structure {
  const indexed = new Map<string, Node[]>()
  for (const node of graph.nodes) {
    if (!node.path) continue
    const nodes = indexed.get(node.path)
    if (nodes) nodes.push(node)
    else indexed.set(node.path, [node])
  }
  const paths = new Set(indexed.keys())
  for (const [path, item] of Object.entries(manifest?.files ?? {})) if (item.text) paths.add(path)
  const groups = new Map<string, string[]>()
  for (const path of paths) {
    const folder = directoryOf(path)
    if (directory !== null && folder !== directory) continue
    const key = directory === null ? folder : path
    const files = groups.get(key)
    if (files) files.push(path)
    else groups.set(key, [path])
  }
  const columns = narrow ? 2 : 3
  const ordered = [...groups.entries()].sort((left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0]))
  const items = ordered.slice(0, columns * 4).map(([key, files], index): DiagramItem => {
    const symbols = files.reduce((total, path) => total + (indexed.get(path)?.length ?? 0), 0)
    const position = { x: (index % columns) * 228, y: Math.floor(index / columns) * 91 }
    return directory === null ? {
      ...position, id: 'directory:' + key, label: key || 'Root files',
      subtitle: files.length + (files.length === 1 ? ' file' : ' files'), role: 'directory', directory: key,
    } : {
      ...position, id: 'file:' + key, label: filename(key),
      subtitle: symbols ? symbols + ' extracted components' : key,
      role: 'source', source: { kind: 'source', path: key, start: 1 },
    }
  })
  const visible = new Set(items.map(item => item.id))
  const nodeIds = new Map(graph.nodes.filter(node => node.path).map(node => [
    node.id, directory === null ? 'directory:' + directoryOf(node.path!) : 'file:' + node.path,
  ]))
  const pairs = new Map<string, { link: DiagramLink; count: number }>()
  for (const edge of graph.edges) {
    const source = nodeIds.get(edge.source)
    const target = nodeIds.get(edge.target)
    if (!source || !target || source === target || !visible.has(source) || !visible.has(target)) continue
    const key = source + '\0' + target
    const pair = pairs.get(key)
    if (pair) {
      pair.count += 1
      if (pair.link.origin === 'inferred' && edge.origin !== 'inferred') {
        pair.link.origin = edge.origin
        pair.link.evidence = edge
      }
    } else {
      pairs.set(key, { count: 1, link: { source, target, label: relation(edge), origin: edge.origin, evidence: edge } })
    }
  }
  const links = [...pairs.values()].sort((left, right) => right.count - left.count).slice(0, 12).map(({ link, count }) =>
    count === 1 ? link : { ...link, label: count + ' relationships' })
  const total = groups.size
  const noun = directory === null ? 'folders and root groups' : 'files'
  return { items, links, title: directory === null ? 'Repository overview' : directory || 'Root files',
    description: (items.length < total ? items.length + ' of ' : '') + total + ' ' + noun }
}
