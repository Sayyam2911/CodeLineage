"""Check the container or a running CodeLineage service."""

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


def request(base, path, *, payload=None, expected=200):
    data = json.dumps(payload).encode() if payload is not None else None
    headers = {"Content-Type": "application/json"} if data is not None else {}
    try:
        with urlopen(Request(base + path, data=data, headers=headers), timeout=45) as response:
            if response.status != expected:
                raise ValueError(f"{path} returned HTTP {response.status}, expected {expected}.")
            return response.read()
    except HTTPError as exc:
        if exc.code != expected:
            raise ValueError(f"{path} returned HTTP {exc.code}, expected {expected}.") from exc


def check_service(base, *, voice=False):
    deadline = time.monotonic() + 90
    while True:
        try:
            health = json.loads(request(base, "/health"))
            break
        except (URLError, ValueError, TimeoutError):
            if time.monotonic() >= deadline:
                raise
            time.sleep(1)
    if health.get("status") != "ok" or b"CodeLineage" not in request(base, "/"):
        raise ValueError("The service is missing its health response or homepage.")
    request(base, f"/internal/analysis/{'0' * 64}/{'0' * 16}/0", payload={}, expected=403)
    if voice and not json.loads(request(base, "/voice/status")).get("available"):
        raise ValueError("The deployed service is missing its voice configuration.")
    print("Verified the homepage, health endpoint and task authentication.", flush=True)
    if voice:
        print("Verified that the deployed voice gateway is configured.", flush=True)


def check_scan(base):
    # Allow both a resumed snapshot and a newly dispatched scan.
    body = {"url": "https://github.com/healthchecks/healthchecks"}
    with urlopen(Request(base + "/scans", data=json.dumps(body).encode(),
                         headers={"Content-Type": "application/json"}), timeout=60) as response:
        scan = json.load(response)
    deadline = time.monotonic() + 2700
    previous = None
    while scan["status"] in {"queued", "scanning", "analyzing"}:
        if scan["status"] != previous:
            previous = scan["status"]
            print(f"Healthchecks scan is {previous}.", flush=True)
        if time.monotonic() >= deadline:
            raise ValueError("The Healthchecks scan is still running. Check the Cloud Run job and Cloud Tasks logs.")
        time.sleep(5)
        scan = json.loads(request(base, f"/scans/{scan['id']}"))
    if scan["status"] not in {"ready", "partial"} or not scan["commit"].startswith("51a5035"):
        raise ValueError("The pinned Healthchecks scan did not finish successfully.")
    snapshot = f"/snapshots/{scan['snapshotId']}"
    graph = json.loads(request(base, snapshot + "/graph"))
    source = json.loads(request(base, snapshot + "/source?" + urlencode({"path": "hc/api/models.py", "start": 1407, "end": 1409})))
    if not graph["nodes"] or not graph["edges"] or not any("nulls_last=True" in line["text"] for line in source["lines"]):
        raise ValueError("The deployed scan is missing its architecture or pinned alert ordering excerpt.")
    repeat = json.loads(request(base, "/scans", payload=body))
    if not repeat["reused"] or repeat["snapshotId"] != scan["snapshotId"]:
        raise ValueError("A repeated scan did not reuse the saved snapshot.")
    print(f"Verified the Healthchecks scan, graph, pinned source and scan reuse ({scan['status']}).", flush=True)


def check_container():
    # Use a nondefault port and an isolated data directory.
    env = {name: value for name, value in os.environ.items() if not name.startswith(("CODELINEAGE_", "NEO4J_", "AGORA_"))}
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        env.update(PORT="8090", CODELINEAGE_DATA=str(root / "data"))
        with subprocess.Popen([sys.executable, "-m", "codelineage"], env=env) as server:
            try:
                check_service("http://127.0.0.1:8090")
            finally:
                server.terminate()

        worker = subprocess.run([sys.executable, "-m", "codelineage.worker"], env=env, capture_output=True, text=True)
        if worker.returncode != 1 or "Usage: python -m codelineage.worker" not in worker.stderr:
            raise ValueError("The Cloud Run worker entry point failed to start.")

        (root / "demo.py").write_text("def answer():\n    return 42\n", encoding="utf-8")
        selection, output = root / "selection.json", root / "graph.json"
        selection.write_text('["demo.py"]', encoding="utf-8")
        subprocess.run([sys.executable, "-m", "codelineage.extract", str(root), str(selection), str(output)],
                       env=env, check=True, timeout=60)
        if not any(node["label"] == "answer()" for node in json.loads(output.read_text())["nodes"]):
            raise ValueError("Graphify could not extract a Python function.")
        print("Verified the scan worker and packaged extractor.", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("url", nargs="?")
    parser.add_argument("--container", action="store_true")
    parser.add_argument("--voice", action="store_true")
    parser.add_argument("--scan", action="store_true")
    args = parser.parse_args()
    if args.container == bool(args.url):
        parser.error("Provide a service URL or use --container.")
    try:
        if args.container:
            check_container()
        else:
            base = args.url.rstrip("/")
            check_service(base, voice=args.voice)
            if args.scan:
                check_scan(base)
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        parser.exit(1, f"{exc}\n")


if __name__ == "__main__":
    main()
