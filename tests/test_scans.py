import io
import tarfile
import time
from types import SimpleNamespace

from fastapi.testclient import TestClient

from codelineage import snapshots
from codelineage.main import create_app


def write_tar(path, files):
    with tarfile.open(path, "w:gz") as archive:
        for filename, content in files.items():
            content = content.encode()
            member = tarfile.TarInfo("fixture/" + filename)
            member.size = len(content)
            archive.addfile(member, io.BytesIO(content))


def test_scan_uses_real_graphify_and_keeps_unparsed_source(tmp_path, monkeypatch):
    def fixture(_repo, _commit, destination):
        write_tar(destination, {
            "app.py": "def answer():\n    return 42\n",
            "check.ts": "export const service = process.env.BASE_URL || 'https://example.org';\n",
            "client.ts": "export function render(config: { MODEL?: string }) {\n"
                         "  return config.MODEL || 'default-model';\n}\n",
            ".env.example": "BASE_URL=https://example.org\nMODEL=default-model\n# Other settings\n",
            "notes.custom": "Reference behavior is documented here.\n",
        })

    monkeypatch.setattr(snapshots, "download", fixture)
    with TestClient(create_app(tmp_path)) as client:
        payload = {"url": "https://github.com/example/project", "ref": "c" * 40}
        response = client.post("/scans", json=payload)
        assert response.status_code == 202
        scan = response.json()
        for _ in range(200):
            scan = client.get(f"/scans/{scan['id']}").json()
            if scan["status"] in {"ready", "partial", "failed"}:
                break
            time.sleep(0.05)
        assert scan["status"] == "ready", scan
        assert scan["coverage"] == {"parsed": 3, "unparsed": 2}
        snapshot = f"/snapshots/{scan['snapshotId']}"
        graph = client.get(snapshot + "/graph").json()
        assert any(n["label"] == "answer()" and n["path"] == "app.py" for n in graph["nodes"]), graph
        excerpt = client.get(snapshot + "/source", params={"path": "notes.custom", "start": 1, "end": 1})
        assert excerpt.json()["lines"][0]["text"].startswith("Reference behavior")
        citation = client.get(snapshot + "/source", params={
            "path": ".env.example", "start": 1, "end": 2, "context": 4, "follow_config": True,
        }).json()
        assert citation["url"].endswith(".env.example#L1-L2")
        assert citation["highlight"] == {"start": 1, "end": 2}
        assert [row["number"] for row in citation["lines"]] == [1, 2, 3]
        assert citation["implementation"]["url"].endswith("client.ts#L2-L2")
        assert citation["implementation"]["lines"][1]["text"] == "  return config.MODEL || 'default-model';"
        assert client.get(snapshot + "/source", params={"path": "../outside", "start": 1, "end": 1}).status_code == 422
        repeat = client.post("/scans", json=payload)
        assert repeat.status_code == 200 and repeat.json()["reused"]


def test_rejects_archive_paths_and_non_public_github_urls(tmp_path, monkeypatch):
    def fixture(_repo, _commit, destination):
        write_tar(destination, {"../escape": "not source"})

    monkeypatch.setattr(snapshots, "download", fixture)
    with TestClient(create_app(tmp_path)) as client:
        assert client.post("/scans", json={"url": "https://github.com.example.org/a/b"}).status_code == 422
        response = client.post("/scans", json={"url": "https://github.com/a/b", "ref": "f" * 40})
        id_ = response.json()["id"]
        for _ in range(100):
            scan = client.get(f"/scans/{id_}").json()
            if scan["status"] == "failed":
                break
            time.sleep(0.02)
        assert scan["status"] == "failed"
        assert client.get(f"/snapshots/{id_}").status_code == 404


def test_resolve_peels_annotated_tags(monkeypatch):
    monkeypatch.setattr(snapshots.subprocess, "run", lambda *args, **kwargs:
                        SimpleNamespace(stdout=f"{'a' * 40}\trefs/tags/v1\n{'b' * 40}\trefs/tags/v1^{{}}\n"))
    assert snapshots.resolve_commit("example/repo", "v1") == "b" * 40
