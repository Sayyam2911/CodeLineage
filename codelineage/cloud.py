"""Managed persistence and authenticated Cloud Run and Cloud Tasks dispatch."""

import hashlib
import json
import os
import tarfile
from contextlib import contextmanager
from functools import lru_cache
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.parse import urlsplit

from codelineage import neo4j_graph
from codelineage.snapshots import Snapshots
from codelineage.store import Database


class Neo4jRecords:
    def __init__(self, transaction):
        self.transaction = transaction

    def get(self, namespace: str, key: str, default=None):
        row = self.transaction.run(
            "MATCH (r:LineageRecord {namespace:$namespace, key:$key}) RETURN r.payload AS payload",
            namespace=namespace, key=key,
        ).single()
        return json.loads(row["payload"]) if row else default

    def items(self, namespace: str) -> list[tuple[str, dict]]:
        return [(row["key"], json.loads(row["payload"])) for row in self.transaction.run(
            "MATCH (r:LineageRecord {namespace:$namespace}) RETURN r.key AS key, r.payload AS payload ORDER BY key",
            namespace=namespace,
        )]

    def put(self, namespace: str, key: str, value: dict) -> None:
        self.transaction.run(
            "MERGE (r:LineageRecord {namespace:$namespace, key:$key}) SET r.payload=$payload",
            namespace=namespace, key=key, payload=json.dumps(value),
        ).consume()
        if namespace.startswith("claims:"):
            self.write_claim(namespace.removeprefix("claims:"), value)
        elif namespace in {"findings", "semantic"}:
            neo4j_graph.write_findings(self.transaction, key, namespace, value["items"])

    def write_claim(self, repo: str, claim: dict):
        self.transaction.run(
            """
            MERGE (repo:CodeRepository {name:$repo})
            MERGE (claim:ArchitectureClaim {repo:$repo, id:$claim.claimId})
            MERGE (repo)-[:HAS_CLAIM]->(claim)
            MERGE (rev:ClaimRevision {repo:$repo, revision:$claim.revision})
            SET rev.title=$claim.title, rev.statement=$claim.statement, rev.origin=$claim.origin,
                rev.speaker=$claim.speaker, rev.operation=$claim.operation, rev.label=$claim.label,
                rev.topicId=$claim.topicId
            MERGE (claim)-[:HAS_REVISION]->(rev)
            MERGE (snapshot:CodeSnapshot {id:$claim.snapshotId})
            MERGE (repo)-[:HAS_SNAPSHOT]->(snapshot)
            MERGE (rev)-[:RECORDED_AT]->(snapshot)
            WITH claim, rev, snapshot
            FOREACH (path IN $claim.scopes |
                MERGE (scope:DecisionScope {repo:$repo, path:path})
                MERGE (rev)-[:APPLIES_TO]->(scope)
            )
            FOREACH (ref IN $refs |
                MERGE (e:ClaimEvidence {repo:$repo, revision:$claim.revision, position:ref.position})
                SET e.kind=ref.kind, e.path=ref.path, e.start=ref.start, e.end=ref.end,
                    e.turnId=ref.turnId, e.sessionId=ref.sessionId, e.text=ref.text, e.speaker=ref.speaker,
                    e.title=ref.title, e.url=ref.url, e.snapshotId=ref.snapshotId
                MERGE (rev)-[:SUPPORTED_BY]->(e)
                FOREACH (_ IN CASE WHEN ref.kind='source' AND ref.path IS NOT NULL THEN [1] ELSE [] END |
                    MERGE (file:SourceFile {snapshot:coalesce(ref.snapshotId, $claim.snapshotId), path:ref.path})
                    MERGE (e)-[:CITES]->(file)
                )
            )
            FOREACH (_ IN CASE WHEN $claim.targetId IS NULL THEN [] ELSE [1] END |
                MERGE (target:GraphTarget {snapshot:$claim.snapshotId, id:$claim.targetId})
                MERGE (rev)-[:ANNOTATES]->(target)
            )
            FOREACH (_ IN CASE WHEN $claim.exceptionTo IS NULL THEN [] ELSE [1] END |
                MERGE (base:ArchitectureClaim {repo:$repo, id:$claim.exceptionTo})
                MERGE (rev)-[:EXCEPTION_TO]->(base)
            )
            FOREACH (_ IN CASE WHEN $claim.operation='add_component' AND $claim.targetId IS NOT NULL THEN [1] ELSE [] END |
                MERGE (component:GraphTarget {snapshot:$claim.snapshotId, id:$claim.targetId})
                SET component:InterviewComponent, component.label=$claim.label, component.origin='interview'
                MERGE (rev)-[:INTRODUCES]->(component)
            )
            FOREACH (_ IN CASE WHEN $claim.operation='add_connection'
                                AND $claim.targetId IS NOT NULL AND $claim.relatedId IS NOT NULL THEN [1] ELSE [] END |
                MERGE (source:GraphTarget {snapshot:$claim.snapshotId, id:$claim.targetId})
                MERGE (target:GraphTarget {snapshot:$claim.snapshotId, id:$claim.relatedId})
                MERGE (rev)-[:CONNECTS_FROM]->(source)
                MERGE (rev)-[:CONNECTS_TO]->(target)
            )
            WITH rev, snapshot
            MATCH (snapshot)-[:HAS_FINDING]->(finding:ReviewFinding {id:$claim.topicId})
            MERGE (rev)-[:ANSWERS]->(finding)
            """,
            repo=repo, claim=claim,
            refs=[ref | {"position": index} for index, ref in enumerate(claim["evidence"])],
        ).consume()


class Neo4jDatabase:
    def __init__(self, uri: str, user: str, password: str, name: str = "neo4j"):
        from neo4j import GraphDatabase

        self.driver = GraphDatabase.driver(uri, auth=(user, password) if user else None)
        self.name = name
        # Snapshot IDs pin the source and extractor version. Claim revisions are read separately.
        self._snapshot_topology = lru_cache(maxsize=4)(self._load_snapshot_graph)
        with self.driver.session(database=name) as session:
            session.run(
                """CREATE CONSTRAINT lineage_records IF NOT EXISTS FOR (r:LineageRecord)
                   REQUIRE (r.namespace,r.key) IS UNIQUE"""
            ).consume()
            session.run(
                "CREATE CONSTRAINT lineage_mutex IF NOT EXISTS FOR (l:LineageMutex) REQUIRE l.name IS UNIQUE"
            ).consume()
            for constraint in neo4j_graph.CONSTRAINTS:
                session.run(constraint).consume()
            session.run("MERGE (l:LineageMutex {name:'records'}) ON CREATE SET l.version=0").consume()

    def ensure_snapshot(self, snapshots: Snapshots, snapshot: str) -> None:
        with self.transaction() as records:
            if neo4j_graph.has_snapshot(records.transaction, snapshot):
                return
        self.publish_snapshot(snapshots, snapshot)

    def snapshot_graph(self, snapshots: Snapshots, snapshot: str) -> dict:
        return self._snapshot_topology(snapshots, snapshot)

    def _load_snapshot_graph(self, snapshots: Snapshots, snapshot: str) -> dict:
        with self.transaction() as records:
            graph = neo4j_graph.snapshot_graph(records.transaction, snapshot)
        return graph if graph is not None else self.publish_snapshot(snapshots, snapshot)

    def publish_snapshot(self, snapshots: Snapshots, snapshot: str) -> dict:
        manifest = snapshots.manifest(snapshot)
        graph = snapshots.graph(snapshot)
        with self.transaction(write=True) as records:
            if not neo4j_graph.has_snapshot(records.transaction, snapshot):
                neo4j_graph.write_snapshot(records.transaction, snapshot, manifest, graph)
                for layer in ("findings", "semantic"):
                    if prior := records.get(layer, snapshot):
                        neo4j_graph.write_findings(records.transaction, snapshot, layer, prior["items"])
                for _, claim in records.items("claims:" + manifest["repo"]):
                    if claim["snapshotId"] == snapshot:
                        records.write_claim(manifest["repo"], claim)
        return graph

    @contextmanager
    def transaction(self, *, write: bool = False):
        with self.driver.session(database=self.name) as session, session.begin_transaction() as transaction:
            if write:
                # Direct property dependency takes Neo4j's write lock before reading the counter.
                transaction.run(
                    "MATCH (l:LineageMutex {name:'records'}) SET l.version = l.version + 1"
                ).consume()
            yield Neo4jRecords(transaction)
            transaction.commit()


def file_digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


class StorageSnapshots(Snapshots):
    """Download immutable artifacts on demand and publish the completion object last."""

    def __init__(self, directory: Path, bucket_name: str):
        from google.cloud import storage

        super().__init__(directory)
        self.bucket = storage.Client().bucket(bucket_name)

    def remote_manifest(self, snapshot: str) -> dict:
        from google.api_core.exceptions import NotFound

        self.location(snapshot)
        try:
            return json.loads(self.bucket.blob(f"snapshots/{snapshot}/complete.json").download_as_bytes())
        except NotFound as exc:
            raise FileNotFoundError(snapshot) from exc

    def manifest(self, snapshot: str) -> dict:
        try:
            return super().manifest(snapshot)
        except FileNotFoundError:
            pass
        completion = self.remote_manifest(snapshot)
        target = self.location(snapshot)
        with TemporaryDirectory(dir=self.directory) as temporary:
            work = Path(temporary)
            archive = work / "archive.tar.gz"
            blob = self.bucket.blob(completion["archive"])
            blob.download_to_filename(archive, if_generation_match=completion["generation"])
            if file_digest(archive) != completion["archiveSha256"]:
                raise ValueError("The snapshot archive checksum did not match the completion manifest.")
            extracted = work / "snapshot"
            extracted.mkdir()
            with tarfile.open(archive, "r:gz") as source:
                source.extractall(extracted, filter="data")
            value = json.loads((extracted / "manifest.json").read_text())
            if value["id"] != snapshot or value != completion["manifest"]:
                raise ValueError("The downloaded snapshot does not match its completion manifest.")
            try:
                extracted.rename(target)
            except OSError:
                if not (target / "manifest.json").is_file():
                    raise
        return super().manifest(snapshot)

    def capture(self, repo: str, commit: str, scope: str) -> dict:
        from google.api_core.exceptions import PreconditionFailed
        from codelineage.snapshots import scan_id

        snapshot = scan_id(repo, commit, scope)
        try:
            self.remote_manifest(snapshot)
        except FileNotFoundError:
            pass
        else:
            return self.manifest(snapshot)
        manifest = super().capture(repo, commit, scope)
        with TemporaryDirectory(dir=self.directory) as temporary:
            archive = Path(temporary) / "source.tar.gz"
            with tarfile.open(archive, "w:gz") as package:
                for member in sorted(self.location(snapshot).iterdir()):
                    package.add(member, arcname=member.name)
            checksum = file_digest(archive)
            key = f"snapshots/{snapshot}/artifacts/{checksum}.tar.gz"
            blob = self.bucket.blob(key)
            try:
                blob.upload_from_filename(archive, if_generation_match=0)
            except PreconditionFailed:
                blob.reload()
            completed = self.bucket.blob(f"snapshots/{snapshot}/complete.json")
            try:
                completed.upload_from_string(json.dumps({
                    "archive": key, "archiveSha256": checksum, "generation": int(blob.generation),
                    "manifest": manifest,
                }), content_type="application/json", if_generation_match=0)
            except PreconditionFailed:
                existing = self.remote_manifest(snapshot)
                if existing["manifest"] != manifest:
                    raise ValueError("Another worker published different artifacts for this snapshot.")
        return manifest


def create_stores(directory: Path):
    bucket = os.getenv("CODELINEAGE_SNAPSHOT_BUCKET")
    snapshots = StorageSnapshots(directory / "snapshots", bucket) if bucket else Snapshots(directory / "snapshots")
    uri = os.getenv("NEO4J_URI")
    if uri:
        database = Neo4jDatabase(uri, os.getenv("NEO4J_USER", "neo4j"),
                                 os.getenv("NEO4J_PASSWORD", ""), os.getenv("NEO4J_DATABASE", "neo4j"))
    else:
        database = Database(directory / "lineage.sqlite3")
    return snapshots, database


class CloudPipeline:
    def __init__(self):
        self.job = os.getenv("CODELINEAGE_SCAN_JOB")
        self.queue = os.getenv("CODELINEAGE_TASK_QUEUE")
        self.service = os.getenv("CODELINEAGE_TASK_SERVICE")
        self.identity = os.getenv("CODELINEAGE_TASK_IDENTITY")
        if self.job and not all((self.queue, self.service, self.identity, os.getenv("CODELINEAGE_SNAPSHOT_BUCKET"),
                                 os.getenv("NEO4J_URI"))):
            raise ValueError("Managed scanning requires shared Neo4j and Storage, a queue, task identity and service URL.")
        if self.service and urlsplit(self.service).scheme != "https":
            raise ValueError("The managed task service URL must use HTTPS.")

    def launch(self, scan: dict) -> None:
        from google.cloud import run_v2

        with run_v2.JobsClient() as client:
            client.run_job(request={
                "name": self.job, "overrides": {
                    "container_overrides": [{"args": ["-m", "codelineage.worker", scan["repo"], scan["commit"], scan["scope"], scan["attempt"]]}],
                },
            }, timeout=30)

    def enqueue(self, id_: str, attempt: str, cursor: int) -> None:
        from google.api_core.exceptions import AlreadyExists
        from google.cloud import tasks_v2

        base = self.service.rstrip("/")
        task = {
            "name": f"{self.queue}/tasks/{id_}-{attempt}-{cursor}",
            "http_request": {
                "http_method": tasks_v2.HttpMethod.POST,
                "url": f"{base}/internal/analysis/{id_}/{attempt}/{cursor}",
                "oidc_token": {"service_account_email": self.identity, "audience": base},
            },
        }
        try:
            with tasks_v2.CloudTasksClient() as client:
                client.create_task(parent=self.queue, task=task, timeout=20)
        except AlreadyExists:
            pass

    def authorized(self, bearer: str) -> bool:
        from google.auth.transport.requests import Request
        from google.oauth2.id_token import verify_oauth2_token

        scheme, _, token = bearer.partition(" ")
        if not self.queue or scheme.lower() != "bearer" or not token:
            return False
        try:
            fields = verify_oauth2_token(token, Request(), audience=self.service.rstrip("/"))
        except ValueError:
            return False
        return fields.get("email") == self.identity and fields.get("email_verified") is True
