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
