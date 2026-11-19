"""CodeLineage HTTP service."""

import logging
import os
from contextlib import asynccontextmanager
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Lock

from fastapi import FastAPI, HTTPException, Response
from pydantic import BaseModel, Field

from codelineage.knowledge import Knowledge, head
from codelineage.store import Database
from codelineage.snapshots import Snapshots, relative_path, repo_name, resolve_commit, scan_id

logger = logging.getLogger(__name__)


class ScanRequest(BaseModel):
    url: str = Field(max_length=300)
    ref: str | None = Field(default=None, max_length=200)
    scope: str | None = Field(default=None, max_length=300)


def create_app(data_dir: Path | None = None) -> FastAPI:
    data_dir = data_dir or Path(os.getenv("CODELINEAGE_DATA", ".data"))
    snapshots = Snapshots(data_dir / "snapshots")
    database = Database(data_dir / "lineage.sqlite3")
    knowledge = Knowledge(snapshots, database)
    jobs: dict[str, dict] = {}
    lock = Lock()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        with ThreadPoolExecutor(max_workers=1, thread_name_prefix="scan") as worker:
            app.state.worker = worker
            yield

    app = FastAPI(title="CodeLineage", lifespan=lifespan)
    app.state.snapshots = snapshots

    def run_scan(id_: str, repo: str, commit: str, scope: str) -> None:
        with lock:
            jobs[id_] = {**jobs[id_], "status": "scanning"}
        try:
            manifest = snapshots.capture(repo, commit, scope)
            findings = knowledge.prepare(id_)
            result = {"analysis": findings["mode"], "status": "partial" if manifest["coverage"].get("failed") else "ready",
                      "snapshotId": id_, "coverage": manifest["coverage"]}
        except ValueError as exc:
            result = {"status": "failed", "error": str(exc)}
        except Exception:
            logger.exception("Scan %s failed", id_)
            result = {"status": "failed", "error": "GitHub capture or structural extraction failed. Retry the scan."}
        with lock:
            jobs[id_] = {**jobs[id_], **result}

    @app.get("/health")
    def health():
        return {"status": "ok"}

    @app.post("/scans", status_code=202)
    def start_scan(request: ScanRequest, response: Response):
        try:
            repo = repo_name(request.url)
            scope = relative_path(request.scope) if request.scope else ""
            commit = resolve_commit(repo, request.ref)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        id_ = scan_id(repo, commit, scope)
        common = {"id": id_, "repo": repo, "commit": commit, "scope": scope}
        try:
            manifest = snapshots.manifest(id_)
        except FileNotFoundError:
            pass
        else:
            findings = knowledge.prepare(id_)
            response.status_code = 200
            return {**common, "analysis": findings["mode"], "status": "partial" if manifest["coverage"].get("failed") else "ready",
                    "snapshotId": id_, "coverage": manifest["coverage"], "reused": True}
        with lock:
            existing = jobs.get(id_)
            if existing and existing["status"] != "failed":
                return {**existing, "reused": True}
            jobs[id_] = {**common, "status": "queued"}
            app.state.worker.submit(run_scan, id_, repo, commit, scope)
            return {**jobs[id_], "reused": False}

    @app.get("/scans/{id_}")
    def scan_status(id_: str):
        with lock:
            if id_ in jobs:
                return jobs[id_]
        manifest = snapshot_manifest(id_)
        return {key: manifest[key] for key in ("id", "repo", "commit", "scope", "coverage")} | {
            "status": "partial" if manifest["coverage"].get("failed") else "ready", "snapshotId": id_,
        }

    @app.get("/snapshots/{id_}")
    def snapshot_manifest(id_: str):
        try:
            return snapshots.manifest(id_)
        except FileNotFoundError as exc:
            raise HTTPException(404, "Snapshot not found.") from exc

    @app.get("/snapshots/{id_}/graph")
    def snapshot_graph(id_: str, revision: int | None = None):
        try:
            return knowledge.projection(id_, revision)
        except FileNotFoundError as exc:
            raise HTTPException(404, "Snapshot not found.") from exc
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc

    @app.get("/snapshots/{id_}/review")
    def snapshot_review(id_: str, baseline: str | None = None):
        try:
            return knowledge.compare(id_, baseline)
        except FileNotFoundError as exc:
            raise HTTPException(404, "Snapshot or baseline not found.") from exc
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc

    @app.get("/lineages")
    def lineage(url: str):
        try:
            repo = repo_name(url)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        with database.transaction() as records:
            return head(records, repo) | {"repo": repo}

    @app.get("/snapshots/{id_}/source")
    def snapshot_source(id_: str, path: str, start: int, end: int):
        try:
            return snapshots.source(id_, path, start, end)
        except FileNotFoundError as exc:
            raise HTTPException(404, "Snapshot or source path not found.") from exc
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc

    return app


app = create_app()
