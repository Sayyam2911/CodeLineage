import json

from codelineage.knowledge import Knowledge, head
from codelineage.snapshots import Snapshots
from codelineage.store import Database


def fixture(snapshots, id_, changed=False, repo="example/project"):
    root = snapshots.location(id_)
    source = root / "source"
    source.mkdir(parents=True)
    paths = [f"module_{i}.py" for i in range(7)] + ["docs/retry.md"]
    files = {}
    for path in paths:
        target = source / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("A useful line.\n")
        files[path] = {"sha256": "changed" if changed and path == "module_5.py" else path, "text": True}
    nodes = [{"id": str(i), "label": f"module_{i}", "path": path, "start": 1, "end": 1,
              "origin": "extracted"} for i, path in enumerate(paths[:7])]
    edges = [{"source": str(i), "target": str(i + 1), "relation": "calls", "origin": "extracted",
              "path": paths[i], "start": 1, "end": 1} for i in range(5)]
    edges.append({"source": "5", "target": "6", "relation": "guesses", "origin": "inferred",
                  "path": paths[5], "start": 1, "end": 1})
    (root / "manifest.json").write_text(json.dumps({"repo": repo, "commit": id_[:40], "scope": "", "files": files}))
    (root / "graph.json").write_text(json.dumps({"nodes": nodes, "edges": edges}))


def test_context_follows_supported_hops_and_finds_disconnected_scope(tmp_path):
    snapshots = Snapshots(tmp_path / "snapshots")
    database = Database(tmp_path / "lineage.db")
    prior, current = "a" * 64, "b" * 64
    fixture(snapshots, prior)
    fixture(snapshots, current, changed=True)
    with database.transaction(write=True) as records:
        records.put("lineage", "example/project", head(records, "example/project") |
                    {"revision": 2, "baselines": {"": prior}})
        common = {"snapshotId": prior, "title": "Retry policy", "evidence": [], "operation": "annotate"}
        records.put("claims:example/project", "1", common | {
            "claimId": "shared", "revision": 1, "scopes": ["module_5.py", "module_6.py"],
            "statement": "Retry transient provider errors.", "targetId": "5",
        })
        records.put("claims:example/project", "2", common | {
            "claimId": "exception", "revision": 2, "scopes": ["module_6.py"],
            "statement": "The batch module retries only once.", "targetId": "6", "exceptionTo": "shared",
        })
    knowledge = Knowledge(snapshots, database)
    context = knowledge.context(current, "retry", "0")
    assert len(context["hops"]) == 5
    assert {item["claimId"] for item in context["claims"]} == {"shared", "exception"}
    assert context["documents"][0]["path"] == "docs/retry.md"
    assert knowledge.context(current, "", "6")["claims"]
    review = knowledge.compare(current)
    assert review["baseline"] == prior and review["changedPaths"] == ["module_5.py"]
    assert {"module_4.py", "module_5.py", "module_6.py"} <= set(review["affectedPaths"])
    assert knowledge.projection(current, 1)["claims"][0]["claimId"] == "shared"
