import json

from fastapi.testclient import TestClient

from codelineage.main import create_app
from test_knowledge import fixture


def test_confirmation_is_explicit_revisioned_and_replayable(tmp_path):
    app = create_app(tmp_path)
    snapshot = "a" * 64
    fixture(app.state.snapshots, snapshot)
    url = "https://github.com/example/project"
    with TestClient(app) as client:
        assert client.post("/sessions", json={"url": url, "mode": "understand"}).status_code == 404

        def open_update():
            response = client.post("/sessions", json={"url": url, "mode": "update", "snapshotId": snapshot})
            assert response.status_code == 201, response.text
            session = response.json()
            return f"/sessions/{session['id']}", {"Authorization": f"Bearer {session['token']}"}

        path, headers = open_update()
        concurrent, concurrent_auth = open_update()
        assert client.get(path).status_code == 401

        def stage(base, auth, text):
            response = client.post(base + "/answer", headers=auth, json={"text": text})
            assert response.status_code == 200, response.text
            return response.json()["pending"]

        def readback(base, auth, proposal_id):
            response = client.post(base + "/readback", headers=auth, json={"proposalId": proposal_id})
            assert response.status_code == 200, response.text
            return {"proposalId": proposal_id, "readbackTurnId": response.json()["pending"]["readbackTurnId"]}

        first = stage(path, headers, "Retry all notifications.")
        stale = readback(path, headers, first["id"])
        response = client.post(path + "/interrupt", headers=headers, json={"proposalId": first["id"]})
        assert response.status_code == 200 and not response.json()["pending"]
        corrected = stage(path, headers, "Retry transient errors only for webhooks.")
        unreread = client.post(path + "/confirm", headers=headers, json={"proposalId": corrected["id"]})
        assert unreread.status_code == 409
        assert client.post(path + "/confirm", headers=headers, json=stale).status_code == 409
        graph_url = f"/snapshots/{snapshot}/graph"
        assert client.get(graph_url).json()["claims"] == []

        obsolete = readback(concurrent, concurrent_auth,
                            stage(concurrent, concurrent_auth, "Retry once.")["id"])
        approval = readback(path, headers, corrected["id"])
        saved = client.post(path + "/confirm", headers=headers, json=approval)
        assert saved.status_code == 200, saved.text
        assert saved.json()["revision"] == 1
        assert client.post(path + "/confirm", headers=headers, json=approval).json() == saved.json()
        assert client.post(concurrent + "/confirm", headers=concurrent_auth, json=obsolete).status_code == 409
        assert client.get(graph_url, params={"revision": 0}).json()["claims"] == []
        assert len(client.get(graph_url).json()["claims"]) == 1

        events = client.get(path + "/events", params={"wait": False}, headers=headers)
        rows = [json.loads(line[6:]) for line in events.text.splitlines() if line.startswith("data: ")]
        assert [row["seq"] for row in rows] == list(range(1, len(rows) + 1))
        assert [row["type"] for row in rows].count("revision.committed") == 1
        assert rows[-2]["type"] == "revision.applying"
        resumed = client.get(path + "/events", params={"wait": False},
                             headers=headers | {"Last-Event-ID": rows[-2]["eventId"]})
        assert "revision.committed" in resumed.text and "revision.applying" not in resumed.text

        assert client.post(path + "/skip", headers=headers).status_code == 200
        assert client.post(path + "/finish", headers=headers).status_code == 200
        baseline = client.get("/lineages", params={"url": url}).json()["baselines"]
        assert baseline == {"module_0.py": snapshot}

    with TestClient(create_app(tmp_path)) as client:
        fresh = client.post("/sessions", json={"mode": "understand", "url": url}).json()
        path = f"/sessions/{fresh['id']}"
        headers = {"Authorization": "Bearer " + fresh["token"]}
        reply = client.post(path + "/context", headers=headers, json={"text": "Why retry webhooks?"}).json()
        assert reply["claims"][0]["statement"] == "Retry transient errors only for webhooks."
        assert reply["claims"][0]["evidence"][-1]["kind"] == "interview"
        assert client.post(path + "/answer", headers=headers, json={"text": "Change this."}).status_code == 403
        assert client.post(path + "/finish", headers=headers).status_code == 200
        assert client.get("/lineages", params={"url": url}).json()["baselines"] == baseline


def test_selecting_a_question_preserves_the_rest_of_the_review(tmp_path):
    app = create_app(tmp_path)
    snapshot = "a" * 64
    fixture(app.state.snapshots, snapshot)
    with TestClient(app) as client:
        session = client.post("/sessions", json={"url": "https://github.com/example/project", "mode": "update",
                                                "snapshotId": snapshot}).json()
        path = f"/sessions/{session['id']}"
        auth = {"Authorization": f"Bearer {session['token']}"}
        first, last = session["topics"][0], session["topics"][-1]

        def select(topic):
            return client.post(path + "/topic", headers=auth, json={"topicId": topic["id"]})

        assert client.post(path + "/topic", json={"topicId": last["id"]}).status_code == 401
        assert select({"id": "another-review"}).status_code == 404
        chosen = select(last).json()
        assert chosen["index"] == len(session["topics"]) - 1
        assert chosen["outcomes"] == {} and chosen["revision"] == 0
        assert client.get(path, headers=auth).json() == chosen
        assert select(last).json()["seq"] == chosen["seq"]

        proposal = client.post(path + "/answer", headers=auth, json={"text": "Keep delivery ordered."}).json()["pending"]
        assert proposal["topicId"] == last["id"]
        assert select(first).status_code == 409
        reviewed = client.post(path + "/readback", headers=auth, json={"proposalId": proposal["id"]}).json()["pending"]
        saved = client.post(path + "/confirm", headers=auth, json={"proposalId": proposal["id"],
                                                                  "readbackTurnId": reviewed["readbackTurnId"]}).json()
        assert saved["claim"]["topicId"] == last["id"]
        state = client.get(path, headers=auth).json()
        assert state["index"] == 0 and state["topicVersion"] == saved["topicVersion"]
        assert select(last).status_code == 409
        resumed = select(first).json()
        assert resumed["index"] == 0 and resumed["topicVersion"] > saved["topicVersion"]
        assert client.post(path + "/skip", headers=auth, json={}).json()["index"] == 1
        revisited = select(first).json()
        assert revisited["index"] == 0 and revisited["outcomes"] == {last["id"]: "confirmed", first["id"]: "open"}
