from fastapi import FastAPI
from fastapi.testclient import TestClient

from codelineage.interview import Interviews, interview_routes
from codelineage.knowledge import Knowledge
from codelineage.snapshots import Snapshots
from codelineage.store import Database
from codelineage.voice import AgoraVoice, voice_routes
from test_knowledge import fixture


def test_agora_sdk_config_limits_tools_by_mode(monkeypatch):
    for name, value in {
        "AGORA_APP_ID": "1" * 32, "AGORA_APP_CERTIFICATE": "2" * 32,
        "MURF_API_KEY": "test", "MURF_VOICE_ID": "Ariana",
        "CODELINEAGE_PUBLIC_URL": "https://example.com",
    }.items():
        monkeypatch.setenv(name, value)
    voice = AgoraVoice()
    assert voice.available()
    rtc = voice.rtc({"uid": 1234, "channel": "test-channel", "id": "test-connection"})
    assert rtc["token"].startswith("007") and rtc["channel"] == "test-channel"
    for mode, expected in [
        ("update", {"getDecisionContext", "showEvidence", "proposeChange", "confirmChange"}),
        ("understand", {"getDecisionContext", "showEvidence"}),
    ]:
        agent = voice.agent({"mode": mode, "id": "session"}, "provider-token")
        llm = agent.llm
        assert {entry["function"]["name"] for entry in llm["tools"]} == expected
        assert agent.tts["vendor"] == "murf"
        assert agent.tts["params"]["model"] == "FALCON"


def test_voice_tools_are_session_bound_and_use_verified_transcript(tmp_path):
    snapshots = Snapshots(tmp_path / "snapshots")
    database = Database(tmp_path / "lineage.db")
    fixture(snapshots, "a" * 64)
    service = Interviews(Knowledge(snapshots, database))

    class FakeGateway:
        token = None

        @staticmethod
        def available():
            return True

        @staticmethod
        def rtc(connection):
            return {"connectionId": connection["id"]}

        def start(self, _session, _connection, token):
            FakeGateway.token = token
            return "provider-agent"

        @staticmethod
        def last_participant(_agent):
            return "We retry webhook errors once."

        @staticmethod
        def stop(_agent):
            pass

    app = FastAPI()
    app.include_router(interview_routes(service))
    app.include_router(voice_routes(service, FakeGateway))
    with TestClient(app) as client:
        session = client.post("/sessions", json={
            "mode": "update", "url": "https://github.com/example/project", "snapshotId": "a" * 64,
        }).json()
        browser = {"Authorization": "Bearer " + session["token"]}
        voice = "/voice/sessions/" + session["id"]
        connection = client.post(voice + "/reserve", headers=browser).json()
        assert client.post(voice + "/start", headers=browser, json=connection).status_code == 200
        tools = "/voice/tools/" + session["id"]
        agent = {"Authorization": "Bearer " + FakeGateway.token}
        assert client.post(tools + "/proposeChange", headers=browser, json={"summary": "Fake."}).status_code == 401
        result = client.post(tools + "/proposeChange", headers=agent, json={"summary": "Webhook retries are limited to one."})
        assert result.status_code == 200, result.text
        proposal_id = result.json()["proposalId"]
        path = "/sessions/" + session["id"]
        assert client.post(path + "/readback", headers=agent, json={"proposalId": proposal_id}).status_code == 401
        payload = {"proposalId": proposal_id}
        assert client.post(tools + "/confirmChange", headers=agent, json=payload).json()["status"] == "pending"
        reviewed = client.post(path + "/readback", headers=browser, json=payload).json()
        payload["readbackTurnId"] = reviewed["pending"]["readbackTurnId"]
        assert client.post(path + "/confirm", headers=agent, json=payload).status_code == 401
        saved = client.post(path + "/confirm", headers=browser, json=payload).json()
        assert saved["claim"]["evidence"][-1]["text"] == "We retry webhook errors once."
        assert client.post(tools + "/confirmChange", headers=agent, json=payload).json()["status"] == "saved"
        assert client.post(voice + "/stop", headers=browser, json=connection).status_code == 200
        assert client.post(tools + "/getDecisionContext", headers=agent, json={}).status_code == 401
