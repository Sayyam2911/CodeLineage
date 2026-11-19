from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from google.api_core.exceptions import NotFound, PreconditionFailed

from codelineage import snapshots
from codelineage.cloud import CloudPipeline, StorageSnapshots
from codelineage.main import create_app
from test_scans import write_tar


class FakeBucket:
    def __init__(self):
        self.objects = {}
        self.uploads = []
        self.fail_completion = True

    def blob(self, key):
        return FakeBlob(self, key)


class FakeBlob:
    def __init__(self, bucket, key):
        self.bucket = bucket
        self.key = key
        self.generation = 1

    def upload_from_filename(self, path, if_generation_match):
        self.upload_from_string(Path(path).read_bytes(), if_generation_match=if_generation_match)

    def upload_from_string(self, data, *, if_generation_match, content_type=None):
        assert if_generation_match == 0
        if self.key in self.bucket.objects:
            raise PreconditionFailed("The immutable object already exists.")
        if self.key.endswith("/complete.json") and self.bucket.fail_completion:
            raise OSError("Temporary storage connection failure.")
        self.bucket.objects[self.key] = data.encode() if isinstance(data, str) else data
        self.bucket.uploads.append(self.key)

    def reload(self):
        assert self.key in self.bucket.objects

    def download_as_bytes(self):
        if self.key not in self.bucket.objects:
            raise NotFound("No complete object.")
        return self.bucket.objects[self.key]

    def download_to_filename(self, path, if_generation_match):
        assert if_generation_match == self.generation
        Path(path).write_bytes(self.download_as_bytes())


def test_storage_completion_is_last_and_a_new_instance_can_read_it(tmp_path, monkeypatch):
    calls = []

    def fixture(_repo, _commit, destination):
        calls.append(destination)
        write_tar(destination, {"demo.custom": "This source was stored remotely.\n"})

    monkeypatch.setattr(snapshots, "download", fixture)
    bucket = FakeBucket()

    def instance(name):
        store = StorageSnapshots.__new__(StorageSnapshots)
        snapshots.Snapshots.__init__(store, tmp_path / name)
        store.bucket = bucket
        return store

    writer = instance("writer")
    reader = instance("reader")
    args = ("example/repo", "c" * 40, "")
    with pytest.raises(OSError, match="Temporary"):
        writer.capture(*args)
    with pytest.raises(FileNotFoundError):
        reader.manifest(snapshots.scan_id(*args))
    bucket.fail_completion = False
    result = writer.capture(*args)
    assert len(calls) == 1
    assert bucket.uploads[-1].endswith("/complete.json")
    excerpt = reader.source(result["id"], "demo.custom", 1, 1)
    assert excerpt["lines"] == [{"number": 1, "text": "This source was stored remotely."}]


def test_managed_tasks_reject_unauthenticated_and_stale_attempts(tmp_path, monkeypatch):
    app = create_app(tmp_path)
    with TestClient(app) as client:
        url = "/internal/analysis/" + "a" * 64 + "/old-attempt/0"
        assert client.post(url).status_code == 403
        monkeypatch.setattr(CloudPipeline, "authorized", lambda self, bearer: bearer == "Bearer task-test")
        assert client.post(url, headers={"Authorization": "Bearer task-test"}).json() == {"skipped": True}
