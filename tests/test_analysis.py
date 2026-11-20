import json

import httpx

from codelineage.analysis import SemanticReview
from codelineage.knowledge import Knowledge
from codelineage.snapshots import Snapshots
from codelineage.store import Database
from test_knowledge import fixture


def test_analysis_replay_and_exact_citations(tmp_path, monkeypatch):
    snapshots = Snapshots(tmp_path / "snapshots")
    snapshot = "c" * 64
    fixture(snapshots, snapshot)
    database = Database(tmp_path / "lineage.db")
    knowledge = Knowledge(snapshots, database)
    monkeypatch.setenv("CODELINEAGE_ANALYSIS_KEY", "test")
    review = SemanticReview(knowledge)
    counts = []

    def model(id_, excerpts):
        counts.append(id_)
        content = {
            "path": "module_0.py", "start": 1, "end": 1,
            "title": "Useful line", "statement": "The line suggests a design choice.",
            "question": "What determines the choice?",
        }
        return review.validate(id_, excerpts, [
            content | {"quote": "A useful line."},
            content | {"quote": "This text is not in the source."},
            content | {"quote": "A useful line.", "path": "missing.py"},
        ])

    monkeypatch.setattr(review, "infer", model)
    assert review.start(snapshot)["cursor"] == 0
    state = review.step(snapshot, 0)
    assert state["done"] and state["complete"]
    assert len(state["reviewedPaths"]) == 8
    assert len(state["topics"]) == 1 and state["topics"][0]["origin"] == "inference"
    assert review.step(snapshot, 0) == state
    assert review.start(snapshot) == state and counts == [snapshot]
    assert knowledge.findings(snapshot)["mode"] == "model"



def test_muse_responses_validate_pinned_findings(tmp_path, monkeypatch):
    snapshots = Snapshots(tmp_path / "snapshots")
    snapshot = "c" * 64
    fixture(snapshots, snapshot)
    knowledge = Knowledge(snapshots, Database(tmp_path / "lineage.db"))
    monkeypatch.setenv("CODELINEAGE_ANALYSIS_KEY", "test")
    monkeypatch.delenv("CODELINEAGE_ANALYSIS_MODEL", raising=False)
    monkeypatch.setenv("CODELINEAGE_ANALYSIS_PROVIDER", "openai")
    old = SemanticReview(knowledge).start(snapshot)
    monkeypatch.setenv("CODELINEAGE_ANALYSIS_PROVIDER", "meta")
    review = SemanticReview(knowledge)

    def post(url, *, headers, json: dict, timeout):
        assert url == "https://api.meta.ai/v1/responses"
        assert headers["Authorization"] == "Bearer test"
        assert json["model"] == "muse-spark-1.3-contributor"
        assert json["store"] is False
        assert json["text"]["format"]["type"] == "json_schema"
        assert "A useful line." in json["input"]
        return response

    finding = {"title": "Decision", "statement": "The code suggests a design choice.",
               "question": "Why was it chosen?", "path": "module_0.py", "start": 1, "end": 1}
    completion = json.dumps({"findings": [
        finding | {"quote": "A useful line."}, finding | {"quote": "A fabricated quote."},
    ]})
    response = httpx.Response(200, request=httpx.Request("POST", "https://api.meta.ai/v1/responses"), json={
        "status": "completed", "output": [
            {"type": "reasoning"},
            {"type": "message", "content": [{"type": "output_text", "text": completion}]},
        ],
    })
    monkeypatch.setattr(httpx, "post", post)
    assert review.start(snapshot)["signature"] != old["signature"]
    state = review.step(snapshot, 0)
    assert state["done"] and state["complete"]
    assert [topic["title"] for topic in state["topics"]] == ["Decision"]
