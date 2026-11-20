from types import SimpleNamespace

import pytest
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
    rtc = voice.rtc({"uid": 1234, "agentUid": 5678, "channel": "test-channel", "id": "test-connection"})
    assert rtc["token"].startswith("007") and rtc["channel"] == "test-channel" and rtc["agentUid"] == 5678
    for mode, expected in [
        ("update", {"getDecisionContext", "showEvidence", "proposeChange", "confirmChange"}),
        ("understand", {"getDecisionContext", "showEvidence"}),
    ]:
        agent = voice.agent({"mode": mode, "id": "session"}, "provider-token")
        llm = agent.llm
        assert {entry["function"]["name"] for entry in llm["tools"]} == expected
        assert agent.tts["vendor"] == "murf"
        assert agent.tts["params"]["model"] == "FALCON"


def test_published_pipeline_inherits_providers_and_uses_agent_auth(monkeypatch):
    for name, value in {
        "AGORA_APP_ID": "1" * 32, "AGORA_APP_CERTIFICATE": "2" * 32,
        "AGORA_PIPELINE_ID": "published-pipeline", "CODELINEAGE_PUBLIC_URL": "https://example.com",
    }.items():
        monkeypatch.setenv(name, value)
    monkeypatch.delenv("MURF_API_KEY", raising=False)
    monkeypatch.delenv("MURF_VOICE_ID", raising=False)
    voice = AgoraVoice()
    assert voice.available()
    connection = {"id": "connection", "channel": "speech-room", "uid": 100001, "agentUid": 900001,
                  "guided": True}

    def start(app_id, *, name, pipeline_id, properties, request_options):
        assert app_id == "1" * 32 and name == connection["channel"]
        assert pipeline_id == "published-pipeline"
        assert "asr" not in properties and "tts" not in properties
        assert properties["agent_rtc_uid"] == "900001" and properties["remote_rtc_uids"] == ["100001"]
        assert properties["idle_timeout"] == 300
        assert request_options["additional_headers"]["Authorization"] == "agora token=" + properties["token"]
        tools = properties["llm"]["tools"]
        assert {item["function"]["name"] for item in tools} == {"getDecisionContext", "showEvidence"}
        assert tools[0]["server"]["headers"]["Authorization"] == "Bearer tool-token"
        return SimpleNamespace(agent_id="running-agent")

    def authorized(app_id, agent_id, *, request_options):
        assert app_id == "1" * 32 and agent_id == "running-agent"
        assert request_options["additional_headers"]["Authorization"].startswith("agora token=007")

    def history(*args, **kwargs):
        authorized(*args, **kwargs)
        return SimpleNamespace(contents=[SimpleNamespace(role="user", content="Webhook retries are limited.")])

    voice.client = SimpleNamespace(agents=SimpleNamespace(start=start, get_history=history, stop=authorized))
    session = {"mode": "understand", "id": "session"}
    connection["agentId"] = voice.start(session, connection, "tool-token")
    assert voice.last_participant(connection)[0] == "Webhook retries are limited."
    voice.stop(connection)


@pytest.fixture
def voice_app(tmp_path):
    snapshots = Snapshots(tmp_path / "snapshots")
    database = Database(tmp_path / "lineage.db")
    fixture(snapshots, "a" * 64)
    service = Interviews(Knowledge(snapshots, database))

    class FakeGateway:
        token = None
        spoken = []
        tool_name = "getDecisionContext"
        participant = ("We retry webhook errors once.", "provider-turn")

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
        def last_participant(connection):
            assert connection["agentId"] == "provider-agent"
            return FakeGateway.participant

        @staticmethod
        def history(connection):
            assert connection["agentId"] == "provider-agent"
            lookup = SimpleNamespace(role="tool", content='{"tool": "' + FakeGateway.tool_name + '"}')
            return [
                SimpleNamespace(role="user", content=FakeGateway.tool_name),
                lookup, SimpleNamespace(role="assistant", content=None), lookup,
            ]

        @staticmethod
        def speak(connection, text):
            assert connection["agentId"] == "provider-agent"
            FakeGateway.spoken.append(text)

        @staticmethod
        def stop(connection):
            assert connection["agentId"] == "provider-agent"

    app = FastAPI()
    app.include_router(interview_routes(service))
    app.include_router(voice_routes(service, FakeGateway))
    return app, FakeGateway


def test_voice_tools_are_session_bound_and_use_verified_transcript(voice_app, monkeypatch):
    app, gateway = voice_app
    with TestClient(app) as client:
        session = client.post("/sessions", json={
            "mode": "update", "url": "https://github.com/example/project", "snapshotId": "a" * 64,
        }).json()
        browser = {"Authorization": "Bearer " + session["token"]}
        voice = "/voice/sessions/" + session["id"]
        connection = client.post(voice + "/reserve", headers=browser).json()
        assert client.post(voice + "/start", headers=browser, json=connection).status_code == 200
        tools = "/voice/tools/" + session["id"]
        agent = {"Authorization": "Bearer " + gateway.token}
        for _ in range(2):
            assert client.post(tools + "/getDecisionContext", headers=agent, json={}).status_code == 200
        assert len(gateway.spoken) == 1
        gateway.tool_name = "showEvidence"
        assert client.post(tools + "/showEvidence", headers=agent, json={
            "path": "module_0.py", "start": "1", "end": "1",
        }).status_code == 200
        assert len(gateway.spoken) == 2 and "module_0.py" in gateway.spoken[-1]
        gateway.tool_name = "silent follow-up"
        monkeypatch.setattr("codelineage.voice.VOICE_REPLY_TIMEOUT", 0)
        assert client.post(voice + "/watch", headers=agent, json=connection).status_code == 401
        for _ in range(3):
            assert client.post(voice + "/watch", headers=browser, json=connection).json()["active"]
        assert len(gateway.spoken) == 3
        assert client.post(tools + "/proposeChange", headers=browser, json={"summary": "Fake."}).status_code == 401
        result = client.post(tools + "/proposeChange", headers=agent, json={"summary": "Webhook retries are limited to one."})
        assert result.status_code == 200, result.text
        proposal_id = result.json()["proposalId"]
        repeated = client.post(tools + "/proposeChange", headers=agent, json={"summary": "A repeated deduction."})
        assert repeated.json()["proposalId"] == proposal_id
        assert repeated.json()["summary"] == result.json()["summary"]
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


def test_guided_voice_replays_active_question_and_requires_a_new_recorded_answer(voice_app):
    app, gateway = voice_app
    with TestClient(app) as client:
        session = client.post("/sessions", json={
            "mode": "update", "url": "https://github.com/example/project", "snapshotId": "a" * 64,
        }).json()
        browser = {"Authorization": "Bearer " + session["token"]}
        voice = "/voice/sessions/" + session["id"]
        topic = session["topics"][session["index"]]
        connection = client.post(voice + "/reserve", headers=browser).json()
        started = client.post(voice + "/start", headers=browser, json=connection | {"guided": True})
        assert started.status_code == 200
        agent = {"Authorization": "Bearer " + gateway.token}
        proposal = "/voice/tools/" + session["id"] + "/proposeChange"
        question = connection | {"topicId": topic["id"]}
        assert client.post(voice + "/prompt", headers=agent, json=question).status_code == 401
        assert client.post(voice + "/prompt", headers=browser, json=question | {"topicId": "stale"}).status_code == 409
        assert client.post(voice + "/prompt", headers=browser, json=question).json() == {"spoken": True}
        assert client.post(voice + "/prompt", headers=browser, json=question).json() == {"spoken": False}
        assert client.post(voice + "/prompt", headers=browser, json=question | {"repeat": True}).json() == {"spoken": True}
        assert len(gateway.spoken) == 2
        assert all(prompt.startswith(topic["question"]) and "Press the microphone" in prompt for prompt in gateway.spoken)

        change = {"summary": "Keep duplicate deliveries out of the queue."}
        assert client.post(proposal, headers=agent, json=change).status_code == 409
        capture = question | {"phase": "recording", "change": {"scope": ["module_0.py"]}}
        assert client.post(voice + "/capture", headers=agent, json=capture).status_code == 401
        assert client.post(voice + "/capture", headers=browser, json=capture).json() == {"recording": True}
        assert client.post(proposal, headers=agent, json=change).status_code == 409
        assert client.post(voice + "/capture", headers=browser, json=question | {"phase": "submitted"}).json() == {"recording": False}
        assert client.post(proposal, headers=agent, json=change).status_code == 409

        gateway.participant = ("We keep duplicate deliveries out of the queue.", "new-turn")
        staged = client.post(proposal, headers=agent, json=change)
        assert staged.status_code == 200, staged.text
        assert "Scope: module_0.py" in staged.json()["summary"]
        assert client.post(voice + "/prompt", headers=browser, json=question | {"repeat": True}).status_code == 409
