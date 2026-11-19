"""Cloud Run Job entry point. It publishes source artifacts and enqueues analysis."""

import os
import re
import sys
from pathlib import Path

from codelineage.cloud import CloudPipeline, StorageSnapshots
from codelineage.snapshots import SHA, relative_path, repo_name, scan_id


def run(repo: str, commit: str, scope: str, attempt: str):
    if repo_name(f"https://github.com/{repo}") != repo or not SHA.fullmatch(commit):
        raise ValueError("The job requires a canonical GitHub repository and pinned commit.")
    if not re.fullmatch(r"[a-f0-9]{16}", attempt):
        raise ValueError("The job requires a registered scan attempt.")
    if scope:
        relative_path(scope)
    cloud = CloudPipeline()
    if not all((cloud.queue, cloud.service, cloud.identity)):
        raise ValueError("The scan job requires a Cloud Tasks queue, service URL and identity.")
    directory = Path(os.getenv("CODELINEAGE_DATA", "/tmp/codelineage"))
    snapshots = StorageSnapshots(directory / "snapshots", os.environ["CODELINEAGE_SNAPSHOT_BUCKET"])
    snapshots.capture(repo, commit, scope)
    cloud.enqueue(scan_id(repo, commit, scope), attempt, 0)


if __name__ == "__main__":
    if len(sys.argv) != 5:
        raise SystemExit("Usage: python -m codelineage.worker OWNER/REPO COMMIT SCOPE ATTEMPT")
    run(*sys.argv[1:])
