import os
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from codelineage.cloud import Neo4jDatabase
from codelineage.main import create_app
from test_knowledge import fixture


@pytest.mark.skipif(not os.getenv("CODELINEAGE_TEST_NEO4J_URI"), reason="requires a Neo4j test instance")
def test_snapshot_and_confirmed_revision_are_queryable_in_neo4j(tmp_path, monkeypatch):
    uri = os.environ["CODELINEAGE_TEST_NEO4J_URI"]
    user = os.getenv("CODELINEAGE_TEST_NEO4J_USER", "")
    password = os.getenv("CODELINEAGE_TEST_NEO4J_PASSWORD", "")
    database = os.getenv("CODELINEAGE_TEST_NEO4J_DATABASE", "neo4j")
    for name, value in {
        "NEO4J_URI": uri, "NEO4J_USER": user, "NEO4J_PASSWORD": password, "NEO4J_DATABASE": database,
    }.items():
        monkeypatch.setenv(name, value)
    repo = "example/test-" + uuid4().hex
    snapshot = uuid4().hex * 2
    url = "https://github.com/" + repo
    app = create_app(tmp_path)
    fixture(app.state.snapshots, snapshot, repo=repo)
    db = Neo4jDatabase(uri, user, password, name=database)
    sessions = []
    try:
        with TestClient(app) as client:
            review = client.post("/sessions", json={"url": url, "mode": "update", "snapshotId": snapshot})
            assert review.status_code == 201, review.text
            session = review.json()
            sessions.append(session["id"])

        def fail_disk_graph(_):
            pytest.fail("A published Aura snapshot should not read graph.json.")

        # The restarted app has no cached topology from the scan publication.
        app = create_app(tmp_path)
        monkeypatch.setattr(app.state.snapshots, "graph", fail_disk_graph)
        with TestClient(app) as client:
            graph_url = f"/snapshots/{snapshot}/graph"
            scanned = client.get(graph_url, params={"revision": 0}).json()
            assert len(scanned["nodes"]) == 7 and len(scanned["edges"]) == 6
            assert scanned["edges"][-1]["origin"] == "inferred"
            assert client.get(graph_url, params={"revision": 0}).json() == scanned
            path = f"/sessions/{session['id']}"
            headers = {"Authorization": f"Bearer {session['token']}"}
            answer = client.post(path + "/answer", headers=headers, json={
                "text": "The dispatcher delegates delivery to the queue worker.",
                "operation": "add_connection", "targetId": "0", "relatedId": "6", "label": "delegates delivery",
            })
            assert answer.status_code == 200, answer.text
            proposal = answer.json()["pending"]
            action = {"proposalId": proposal["id"]}
            readback = client.post(path + "/readback", json=action, headers=headers).json()["pending"]
            action["readbackTurnId"] = readback["readbackTurnId"]
            saved = client.post(path + "/confirm", json=action, headers=headers)
            assert saved.status_code == 200, saved.text
            assert client.post(path + "/confirm", json=action, headers=headers).json() == saved.json()
            assert client.get(graph_url, params={"revision": 0}).json() == scanned
            assert client.get(graph_url).json()["edges"][-1]["origin"] == "interview"

            fresh = client.post("/sessions", json={"url": url, "mode": "understand"}).json()
            sessions.append(fresh["id"])
            reply = client.post(f"/sessions/{fresh['id']}/context", json={"text": "Who delegates delivery?", "targetId": "0"},
                                headers={"Authorization": "Bearer " + fresh["token"]}).json()
            assert reply["claims"][0]["statement"] == "The dispatcher delegates delivery to the queue worker."
            assert reply["focus"]["id"] == "0"
            pinned = client.get(f"/snapshots/{snapshot}/source", params={"path": "module_0.py", "start": 1, "end": 1}).json()
            assert pinned["lines"] == [{"number": 1, "text": "A useful line."}]

        with db.driver.session(database=database) as session:
            structure = session.run(
                """MATCH (r:CodeRepository {name:$repo})-[:HAS_SNAPSHOT]->(s:CodeSnapshot {id:$snapshot})
                   MATCH (s)-[:HAS_FILE]->(f:SourceFile)-[:DEFINES]->(a:CodeComponent)-[rel:CODE_RELATION]->(b:CodeComponent)
                   RETURN count(rel) AS relations, collect(DISTINCT rel.origin) AS origins""",
                repo=repo, snapshot=snapshot,
            ).single(strict=True)
            assert structure["relations"] == 6 and set(structure["origins"]) == {"extracted", "inferred"}
            row = session.run(
                """MATCH (:CodeRepository {name:$repo})-[:HAS_CLAIM]->(:ArchitectureClaim)
                          -[:HAS_REVISION]->(r:ClaimRevision)-[:SUPPORTED_BY]->(e:ClaimEvidence)
                   MATCH (r)-[:ANSWERS]->(:ReviewFinding)
                   MATCH (r)-[:CONNECTS_FROM]->(a:CodeComponent), (r)-[:CONNECTS_TO]->(b:CodeComponent)
                   OPTIONAL MATCH (e)-[:CITES]->(file:SourceFile)
                   RETURN r.revision AS revision, a.id AS source, b.id AS target,
                          collect(e.kind) AS kinds, collect(file.path) AS files""",
                repo=repo,
            ).single(strict=True)
            assert row["revision"] == 1 and (row["source"], row["target"]) == ("0", "6")
            assert sorted(row["kinds"]) == ["interview", "source"] and row["files"] == ["module_0.py"]
    finally:
        try:
            # The fixture uses a unique repository, snapshot, and session IDs even on a shared test database.
            with db.driver.session(database=database) as session, session.begin_transaction() as transaction:
                transaction.run(
                    """MATCH (r:LineageRecord)
                       WHERE (r.namespace='sessions' AND r.key IN $sessions)
                          OR (r.namespace='lineage' AND r.key=$repo)
                          OR (r.namespace='findings' AND r.key=$snapshot)
                          OR r.namespace IN $namespaces
                       DELETE r""",
                    sessions=sessions, repo=repo, snapshot=snapshot,
                    namespaces=["claims:" + repo, *[
                        family + ":" + id_ for family in ("events", "turns", "proposals", "receipts") for id_ in sessions
                    ]],
                ).consume()
                transaction.run(
                    """MATCH (n)
                       WHERE (n:CodeRepository AND n.name=$repo)
                          OR (n:CodeSnapshot AND n.id=$snapshot)
                          OR n.repo=$repo OR n.snapshot=$snapshot
                       DETACH DELETE n""",
                    repo=repo, snapshot=snapshot,
                ).consume()
                transaction.commit()
        finally:
            db.driver.close()
