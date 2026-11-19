import os
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from codelineage.cloud import Neo4jDatabase
from codelineage.main import create_app
from test_knowledge import fixture


@pytest.mark.skipif(not os.getenv("CODELINEAGE_TEST_NEO4J_URI"), reason="requires a Neo4j test instance")
def test_confirmed_revision_is_materialized_in_neo4j(tmp_path, monkeypatch):
    uri = os.environ["CODELINEAGE_TEST_NEO4J_URI"]
    monkeypatch.setenv("NEO4J_URI", uri)
    monkeypatch.setenv("NEO4J_USER", os.getenv("CODELINEAGE_TEST_NEO4J_USER", ""))
    monkeypatch.setenv("NEO4J_PASSWORD", os.getenv("CODELINEAGE_TEST_NEO4J_PASSWORD", ""))
    repo = "example/test-" + uuid4().hex
    url = "https://github.com/" + repo
    app = create_app(tmp_path)
    snapshot = "d" * 64
    fixture(app.state.snapshots, snapshot, repo=repo)
    with TestClient(app) as client:
        session = client.post("/sessions", json={"url": url, "mode": "update", "snapshotId": snapshot}).json()
        path = f"/sessions/{session['id']}"
        headers = {"Authorization": "Bearer " + session["token"]}
        proposal = client.post(path + "/answer", json={"text": "We preserve queueing order."}, headers=headers).json()["pending"]
        action = {"proposalId": proposal["id"]}
        readback = client.post(path + "/readback", json=action, headers=headers).json()["pending"]
        action["readbackTurnId"] = readback["readbackTurnId"]
        saved = client.post(path + "/confirm", json=action, headers=headers)
        assert saved.status_code == 200, saved.text
        assert client.post(path + "/confirm", json=action, headers=headers).json() == saved.json()
        fresh = client.post("/sessions", json={"url": url, "mode": "understand"}).json()
        reply = client.post(f"/sessions/{fresh['id']}/context", json={"text": "queueing order"},
                            headers={"Authorization": "Bearer " + fresh["token"]}).json()
        assert reply["claims"][0]["statement"] == "We preserve queueing order."

    db = Neo4jDatabase(uri, os.environ["NEO4J_USER"], os.environ["NEO4J_PASSWORD"])
    with db.driver.session() as session:
        row = session.run(
            """MATCH (:CodeRepository {name:$repo})-[:HAS_CLAIM]->(:ArchitectureClaim)
                       -[:HAS_REVISION]->(r:ClaimRevision)-[:SUPPORTED_BY]->(e:ClaimEvidence)
               RETURN r.revision AS revision, collect(e.kind) AS kinds""", repo=repo,
        ).single()
        assert row["revision"] == 1 and sorted(row["kinds"]) == ["interview", "source"]
    db.driver.close()
