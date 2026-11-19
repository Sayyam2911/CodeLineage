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
