"""Native graph representation of an immutable, commit-pinned code snapshot."""

GRAPH_VERSION = 1
BATCH_SIZE = 1000

CONSTRAINTS = (
    "CREATE CONSTRAINT code_repository IF NOT EXISTS FOR (n:CodeRepository) REQUIRE n.name IS UNIQUE",
    "CREATE CONSTRAINT code_snapshot IF NOT EXISTS FOR (n:CodeSnapshot) REQUIRE n.id IS UNIQUE",
    "CREATE CONSTRAINT source_file IF NOT EXISTS FOR (n:SourceFile) REQUIRE (n.snapshot, n.path) IS UNIQUE",
    "CREATE CONSTRAINT graph_target IF NOT EXISTS FOR (n:GraphTarget) REQUIRE (n.snapshot, n.id) IS UNIQUE",
    "CREATE CONSTRAINT review_finding IF NOT EXISTS FOR (n:ReviewFinding) REQUIRE (n.snapshot, n.layer, n.id) IS UNIQUE",
)


def has_snapshot(transaction, snapshot: str) -> bool:
    return transaction.run(
        "MATCH (s:CodeSnapshot {id:$snapshot, structureVersion:$version}) RETURN s.id",
        snapshot=snapshot, version=GRAPH_VERSION,
    ).single() is not None


def snapshot_graph(transaction, snapshot: str) -> dict | None:
    row = transaction.run(
        """
        MATCH (s:CodeSnapshot {id:$snapshot, structureVersion:$version})
        CALL (s) {
            MATCH (s)-[:HAS_COMPONENT]->(n:CodeComponent)
            WITH n ORDER BY n.position
            RETURN collect(n {.id, .label, .path, .start, .end, .origin}) AS nodes
        }
        CALL (s) {
            MATCH (s)-[:HAS_COMPONENT]->(source:CodeComponent)-[r:CODE_RELATION]->(target:CodeComponent)
            WHERE r.snapshot = s.id
            WITH r, source, target ORDER BY r.position
            RETURN collect(r {.relation, .origin, .confidence, .path, .start, .end,
                              source:source.id, target:target.id}) AS edges
        }
        RETURN nodes, edges, s.componentCount AS componentCount, s.relationCount AS relationCount
        """,
        snapshot=snapshot, version=GRAPH_VERSION,
    ).single()
    if row is None:
        return None
    if len(row["nodes"]) != row["componentCount"] or len(row["edges"]) != row["relationCount"]:
        raise ValueError("The stored code graph is incomplete for this snapshot.")
    return {"nodes": row["nodes"], "edges": row["edges"]}


def write_batches(transaction, snapshot: str, statement: str, rows: list[dict]) -> None:
    for offset in range(0, len(rows), BATCH_SIZE):
        transaction.run(statement, snapshot=snapshot, rows=rows[offset:offset + BATCH_SIZE]).consume()


def write_snapshot(transaction, snapshot: str, manifest: dict, graph: dict) -> None:
    nodes, edges = graph["nodes"], graph["edges"]
    ids = {node["id"] for node in nodes}
    if len(ids) != len(nodes) or any(edge["source"] not in ids or edge["target"] not in ids for edge in edges):
        raise ValueError("The extracted graph has duplicate or missing components.")
    transaction.run(
        """
        MERGE (repo:CodeRepository {name:$repo})
        MERGE (s:CodeSnapshot {id:$snapshot})
        SET s.commit=$commit, s.scope=$scope
        MERGE (repo)-[:HAS_SNAPSHOT]->(s)
        """,
        repo=manifest["repo"], snapshot=snapshot, commit=manifest["commit"], scope=manifest["scope"],
    ).consume()
    write_batches(transaction, snapshot, """
        MATCH (s:CodeSnapshot {id:$snapshot})
        UNWIND $rows AS row
        MERGE (file:SourceFile {snapshot:$snapshot, path:row.path})
        SET file.name=row.name, file.sha256=row.sha256, file.text=row.text,
            file.size=row.size, file.language=row.language, file.structure=row.structure,
            file.linkTarget=row.linkTarget
        MERGE (s)-[:HAS_FILE]->(file)
        """, [item | {"path": path, "name": path.rsplit("/", 1)[-1]} for path, item in manifest["files"].items()])
    write_batches(transaction, snapshot, """
        MATCH (s:CodeSnapshot {id:$snapshot})
        UNWIND $rows AS row
        MERGE (component:GraphTarget {snapshot:$snapshot, id:row.id})
        SET component:CodeComponent, component.label=row.label, component.path=row.path,
            component.origin=row.origin, component.start=row.start, component.end=row.end,
            component.position=row.position
        MERGE (s)-[:HAS_COMPONENT]->(component)
        WITH row, component
        MATCH (file:SourceFile {snapshot:$snapshot, path:row.path})
        MERGE (file)-[:DEFINES]->(component)
        """, [node | {"position": index} for index, node in enumerate(nodes)])
    write_batches(transaction, snapshot, """
        UNWIND $rows AS row
        MATCH (source:GraphTarget {snapshot:$snapshot, id:row.source})
        MATCH (target:GraphTarget {snapshot:$snapshot, id:row.target})
        MERGE (source)-[r:CODE_RELATION {snapshot:$snapshot, position:row.position}]->(target)
        SET r.relation=row.relation, r.origin=row.origin, r.confidence=row.confidence,
            r.path=row.path, r.start=row.start, r.end=row.end
        """, [edge | {"position": index} for index, edge in enumerate(edges)])
    transaction.run(
        """
        MATCH (s:CodeSnapshot {id:$snapshot})
        SET s.structureVersion=$version, s.componentCount=$components, s.relationCount=$relations
        """,
        snapshot=snapshot, version=GRAPH_VERSION, components=len(nodes), relations=len(edges),
    ).consume()


def write_findings(transaction, snapshot: str, layer: str, items: list[dict]) -> None:
    transaction.run(
        """
        MATCH (:CodeSnapshot {id:$snapshot})-[:HAS_FINDING]->(f:ReviewFinding {layer:$layer})
        WHERE NOT f.id IN $ids
        SET f.active=false
        """,
        snapshot=snapshot, layer=layer, ids=[item["id"] for item in items],
    ).consume()
    transaction.run(
        """
        MATCH (s:CodeSnapshot {id:$snapshot})
        UNWIND $items AS item
        MERGE (f:ReviewFinding {snapshot:$snapshot, layer:$layer, id:item.id})
        SET f.title=item.title, f.statement=item.statement, f.question=item.question,
            f.origin=item.origin, f.scope=item.scope, f.active=true
        MERGE (s)-[:HAS_FINDING]->(f)
        WITH f, item
        OPTIONAL MATCH (target:GraphTarget {snapshot:$snapshot, id:item.targetId})
        FOREACH (_ IN CASE WHEN target IS NULL THEN [] ELSE [1] END | MERGE (f)-[:TARGETS]->(target))
        WITH f, item
        UNWIND item.evidence AS ref
        WITH f, ref WHERE ref.kind='source'
        MATCH (file:SourceFile {snapshot:coalesce(ref.snapshotId, $snapshot), path:ref.path})
        MERGE (f)-[citation:CITES {position:ref.position}]->(file)
        SET citation.start=ref.start, citation.end=ref.end
        """,
        snapshot=snapshot, layer=layer,
        items=[item | {"evidence": [ref | {"position": index} for index, ref in enumerate(item["evidence"])]}
               for item in items],
    ).consume()
