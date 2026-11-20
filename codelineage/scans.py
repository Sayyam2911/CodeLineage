"""Scan lifecycle shared by the local worker, Cloud Run Job and task handlers."""

import logging
import secrets
import time

from codelineage.analysis import SemanticReview
from codelineage.snapshots import scan_id

logger = logging.getLogger(__name__)
RUNNING = {"queued", "scanning", "analyzing"}
INACTIVE_SECONDS = 1500
MANAGED_CAPTURE_SECONDS = 2700


class Scans:
    def __init__(self, knowledge, cloud):
        self.knowledge = knowledge
        self.snapshots = knowledge.snapshots
        self.database = knowledge.database
        self.cloud = cloud
        self.semantic = SemanticReview(knowledge)

    def expired(self, scan: dict) -> bool:
        # Cloud Run can give each of the two capture attempts up to 20 minutes.
        timeout = MANAGED_CAPTURE_SECONDS if self.cloud.job and scan["status"] == "scanning" else INACTIVE_SECONDS
        return time.time() - scan["updated"] >= timeout

    def get(self, scan: str) -> dict:
        with self.database.transaction() as records:
            job = records.get("scan", scan)
        if job:
            if job["status"] in RUNNING and self.expired(job):
                with self.database.transaction(write=True) as records:
                    job = records.get("scan", scan)
                    if job["status"] in RUNNING and self.expired(job):
                        job |= {"status": "failed", "error": "The scan has timed out. Retry to resume.", "updated": time.time()}
                        records.put("scan", scan, job)
            return job
        manifest = self.snapshots.manifest(scan)
        return self.result(manifest)

    def result(self, manifest: dict, *, complete: bool = True) -> dict:
        id_ = manifest["id"]
        self.database.ensure_snapshot(self.snapshots, id_)
        analysis = self.knowledge.findings(id_)
        partial = bool(manifest["coverage"].get("failed")) or not complete
        return {key: manifest[key] for key in ("id", "repo", "commit", "scope", "coverage")} | {
            "status": "partial" if partial else "ready", "snapshotId": id_, "analysis": analysis["mode"],
            "semanticCoverage": {"reviewed": len(analysis["reviewedPaths"]), "complete": analysis.get("complete", False)},
        }

    def update(self, id_: str, data: dict) -> dict:
        with self.database.transaction(write=True) as records:
            result = records.get("scan", id_, {}) | data | {"updated": time.time()}
            if result.get("status") != "failed":
                result.pop("error", None)
            records.put("scan", id_, result)
        return result

    def begin(self, repo: str, commit: str, scope: str) -> tuple[dict, bool]:
        id_ = scan_id(repo, commit, scope)
        common = {"id": id_, "repo": repo, "commit": commit, "scope": scope}
        try:
            self.snapshots.manifest(id_)
            cached = self.semantic.start(id_)
            if cached["done"]:
                result = self.result(self.snapshots.manifest(id_), complete=cached["complete"])
                return self.update(id_, result), True
        except FileNotFoundError:
            pass
        with self.database.transaction(write=True) as records:
            prior = records.get("scan", id_)
            if prior and prior["status"] in RUNNING and not self.expired(prior):
                return prior, True
            job = common | {"status": "queued", "updated": time.time(), "attempt": secrets.token_hex(8)}
            records.put("scan", id_, job)
        return job, False

    def dispatch(self, id_: str):
        try:
            if self.cloud.job:
                scan = self.update(id_, {"status": "scanning"})
                self.cloud.launch(scan)
                return scan
            return self.run(id_)
        except ValueError as exc:
            logger.warning("Scan %s failed: %s", id_, exc)
            return self.update(id_, {"status": "failed", "error": str(exc)})
        except Exception:
            logger.exception("Scan %s failed", id_)
            return self.update(id_, {"status": "failed", "error": "Capture or analysis could not finish. Retry the scan."})

    def recover_local(self, worker):
        if self.cloud.job:
            return
        with self.database.transaction() as records:
            pending = [key for key, value in records.items("scan") if value["status"] in RUNNING]
        for id_ in pending:
            worker.submit(self.dispatch, id_)

    def run(self, id_: str):
        job = self.get(id_)
        if job["status"] != "analyzing":
            self.update(id_, {"status": "scanning"})
        manifest = self.snapshots.capture(job["repo"], job["commit"], job["scope"])
        self.knowledge.prepare(id_)
        work = self.semantic.start(id_)
        if work["done"]:
            self.update(id_, self.result(manifest, complete=work["complete"]))
            return
        self.update(id_, {"status": "analyzing", "snapshotId": id_, "coverage": manifest["coverage"]})
        while not work["done"]:
            work = self.step(id_, work["cursor"])

    def on_task(self, id_: str, cursor: int) -> dict:
        manifest = self.snapshots.manifest(id_)
        if cursor == 0:
            self.knowledge.prepare(id_)
            work = self.semantic.start(id_)
            if work["done"]:
                self.update(id_, self.result(manifest, complete=work["complete"]))
                return work
            self.update(id_, {"status": "analyzing", "snapshotId": id_, "coverage": manifest["coverage"]})
        return self.step(id_, cursor)

    def step(self, id_: str, cursor: int) -> dict:
        work = self.semantic.step(id_, cursor)
        if work["done"]:
            manifest = self.snapshots.manifest(id_)
            self.update(id_, self.result(manifest, complete=work["complete"]))
        else:
            self.update(id_, {"status": "analyzing"})
        return work
