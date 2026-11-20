"""CodeLineage HTTP service."""

import os
from contextlib import asynccontextmanager
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException, Query, Response
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from codelineage.cloud import CloudPipeline, create_stores
from codelineage.interview import Interviews, interview_routes
from codelineage.knowledge import Knowledge, head
from codelineage.scans import RUNNING, Scans
from codelineage.snapshots import relative_path, repo_name, resolve_commit
from codelineage.voice import voice_routes


class ScanRequest(BaseModel):
    url: str = Field(max_length=300)
    ref: str | None = Field(default=None, max_length=200)
    scope: str | None = Field(default=None, max_length=300)


def create_app(data_dir: Path | None = None) -> FastAPI:
    directory = data_dir or Path(os.getenv("CODELINEAGE_DATA", ".data"))
    snapshots, database = create_stores(directory)
    knowledge = Knowledge(snapshots, database)
    cloud = CloudPipeline()
    scans = Scans(knowledge, cloud)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        with ThreadPoolExecutor(max_workers=1, thread_name_prefix="scan") as worker:
            app.state.worker = worker
            scans.recover_local(worker)
            yield

    app = FastAPI(title="CodeLineage", lifespan=lifespan)
    app.state.snapshots = snapshots
    interviews = Interviews(knowledge)
    app.include_router(interview_routes(interviews))
    app.include_router(voice_routes(interviews))

    @app.get("/health")
    def health():
        return {"status": "ok"}

    @app.post("/scans", status_code=202)
    def start_scan(request: ScanRequest, response: Response):
        try:
            repo = repo_name(request.url)
            scope = relative_path(request.scope) if request.scope else ""
            commit = resolve_commit(repo, request.ref)
            scan, reused = scans.begin(repo, commit, scope)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        if not reused:
            if cloud.job:
                scan = scans.dispatch(scan["id"])
            else:
                app.state.worker.submit(scans.dispatch, scan["id"])
        if scan["status"] not in RUNNING:
            response.status_code = 200
        return scan | {"reused": reused}

    @app.get("/scans/{id_}")
    def scan_status(id_: str):
        try:
            return scans.get(id_)
        except FileNotFoundError as exc:
            raise HTTPException(404, "Scan not found.") from exc

    @app.post("/internal/analysis/{id_}/{attempt}/{cursor}", include_in_schema=False)
    def analysis_task(id_: str, attempt: str, cursor: int, authorization: str = Header(default="")):
        if not cloud.authorized(authorization):
            raise HTTPException(403, "The analysis task identity is required.")
        try:
            job = scans.get(id_)
        except FileNotFoundError:
            return {"skipped": True}
        if job.get("attempt") != attempt:
            return {"skipped": True}
        state = scans.on_task(id_, cursor)
        if not state["done"] and state["cursor"] > cursor:
            cloud.enqueue(id_, attempt, state["cursor"])
        return {"cursor": state["cursor"], "done": state["done"]}

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

    @app.get("/snapshots/{id_}/findings")
    def snapshot_findings(id_: str):
        try:
            return knowledge.findings(id_)
        except FileNotFoundError as exc:
            raise HTTPException(404, "Snapshot not found.") from exc

    @app.get("/lineages")
    def lineage(url: str):
        try:
            repo = repo_name(url)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        with database.transaction() as records:
            return head(records, repo) | {"repo": repo}

    @app.get("/snapshots/{id_}/source")
    def snapshot_source(id_: str, path: str, start: int = 1, end: int | None = None,
                        context: int = Query(default=0, ge=0, le=12), follow_config: bool = False):
        try:
            excerpt = snapshots.source(id_, path, start, end, context=context)
            if follow_config and (implementation := snapshots.config_implementation(id_, excerpt, context=context)):
                excerpt["implementation"] = implementation
            return excerpt
        except FileNotFoundError as exc:
            raise HTTPException(404, "Snapshot or source path not found.") from exc
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc

    dist = Path(os.getenv("CODELINEAGE_WEB", str(Path(__file__).resolve().parents[1] / "web" / "dist")))
    if (dist / "index.html").is_file():
        if (dist / "_next").is_dir():
            app.mount("/_next", StaticFiles(directory=dist / "_next"), name="web-next-assets")
        if (dist / "assets").is_dir():
            app.mount("/assets", StaticFiles(directory=dist / "assets"), name="web-assets")

        @app.get("/", include_in_schema=False)
        def website():
            return FileResponse(dist / "index.html", headers={"Cache-Control": "no-cache"})

    return app


app = create_app()
