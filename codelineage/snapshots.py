"""Capture pinned public GitHub source and store reproducible scan artifacts."""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
import tarfile
from pathlib import Path, PurePosixPath
from tempfile import TemporaryDirectory
from urllib.parse import quote, urlsplit

import httpx

DEMO_REPO = "healthchecks/healthchecks"
DEMO_COMMIT = "51a503531d845fc11d5ef270d576c59c300e3620"
ANALYZER = "graphify-0.9.112"
MAX_BYTES = 250 * 1024 * 1024
MAX_FILES = 20_000
SHA = re.compile(r"[a-fA-F0-9]{40}")
REPO_PATH = re.compile(r"/([A-Za-z0-9-]+/[A-Za-z0-9_.-]+?)(?:\.git)?/?")


def repo_name(url: str) -> str:
    parsed = urlsplit(url.strip())
    match = REPO_PATH.fullmatch(parsed.path)
    if (
        parsed.scheme != "https" or parsed.netloc.lower() != "github.com"
        or parsed.query or parsed.fragment or not match
        or match[1].split("/")[-1] in {".", ".."}
    ):
        raise ValueError("Enter a public GitHub repository URL such as https://github.com/owner/repository.")
    return match[1].lower()


def relative_path(value: str) -> str:
    if not value or "\\" in value or "\x00" in value or any(
        part in {"", ".", ".."} for part in value.split("/")
    ):
        raise ValueError("Choose a path inside the repository.")
    return value


def resolve_commit(repo: str, ref: str | None) -> str:
    if repo == DEMO_REPO and ref is None:
        return DEMO_COMMIT
    if ref and SHA.fullmatch(ref):
        return ref.lower()
    if ref and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_./-]{0,199}", ref):
        raise ValueError("Use a commit SHA, branch or tag.")
    patterns = ["HEAD"] if not ref else [f"refs/heads/{ref}", f"refs/tags/{ref}", f"refs/tags/{ref}^{{}}"]
    try:
        result = subprocess.run(
            ["git", "-c", "credential.helper=", "ls-remote", "--exit-code",
             f"https://github.com/{repo}.git", *patterns],
            capture_output=True, text=True, timeout=20, check=True,
            env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
        )
    except (subprocess.SubprocessError, OSError) as exc:
        raise ValueError("The public repository or ref could not be resolved on GitHub.") from exc
    refs = dict(line.split("\t")[::-1] for line in result.stdout.splitlines())
    for pattern in reversed(patterns) if ref else patterns:
        if pattern in refs and SHA.fullmatch(refs[pattern]):
            if ref and patterns[0] in refs and patterns[1] in refs:
                raise ValueError("A branch and tag share this name. Use the commit SHA.")
            return refs[pattern]
    raise ValueError("The selected ref did not resolve to a commit.")


def read_source_lines(path: Path) -> list[str]:
    text = path.read_text(encoding="utf-8")
    if not text:
        return []
    return text.removesuffix("\n").split("\n")


def scan_id(repo: str, commit: str, scope: str) -> str:
    return hashlib.sha256(f"{repo}\0{commit}\0{scope}\0{ANALYZER}".encode()).hexdigest()


def unpack(archive: Path, root: Path) -> dict[str, dict]:
    files: dict[str, dict] = {}
    total = 0
    with tarfile.open(archive, "r|gz") as source:
        prefix = None
        entries = 0
        for member in source:
            entries += 1
            if entries > MAX_FILES * 2:
                raise ValueError("The GitHub archive exceeds the entry limit.")
            name = member.name.rstrip("/")
            path = PurePosixPath(relative_path(name))
            if prefix is None:
                prefix = path.parts[0]
            if path.parts[0] != prefix:
                raise ValueError("Unexpected GitHub archive root.")
            if len(path.parts) == 1 or member.isdir():
                continue
            relative = PurePosixPath(*path.parts[1:]).as_posix()
            if relative in files or len(files) >= MAX_FILES:
                raise ValueError("The snapshot exceeds its file limit or contains duplicate paths.")
            if ".git" in path.parts[1:]:
                raise ValueError("Unexpected Git metadata in archive.")
            if not member.isfile():
                files[relative] = {"size": 0, "text": False, "structure": "non-regular",
                                   "linkTarget": member.linkname or None}
                continue
            total += member.size
            if total > MAX_BYTES:
                raise ValueError("The snapshot exceeds its unpacked source limit.")
            stream = source.extractfile(member)
            if stream is None:
                raise ValueError("GitHub archive contains an unreadable file.")
            data = stream.read()
            if len(data) != member.size:
                raise ValueError("GitHub archive ended before a file was complete.")
            target = root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            try:
                data.decode("utf-8")
                text = b"\0" not in data
            except UnicodeDecodeError:
                text = False
            files[relative] = {
                "size": len(data), "sha256": hashlib.sha256(data).hexdigest(),
                "text": text, "language": path.suffix.lstrip(".").lower() or None,
                "structure": "unparsed" if text else "binary",
            }
    if not files:
        raise ValueError("The repository contains no files.")
    return files


def download(repo: str, commit: str, destination: Path) -> None:
    with httpx.stream("GET", f"https://codeload.github.com/{repo}/tar.gz/{commit}", timeout=30) as response:
        response.raise_for_status()
        size = 0
        with destination.open("wb") as target:
            for chunk in response.iter_bytes():
                size += len(chunk)
                if size > MAX_BYTES:
                    raise ValueError("The GitHub archive exceeds the download limit.")
                target.write(chunk)


class Snapshots:
    def __init__(self, directory: Path):
        self.directory = directory.resolve()
        self.directory.mkdir(parents=True, exist_ok=True)

    def location(self, snapshot: str) -> Path:
        if not re.fullmatch(r"[a-f0-9]{64}", snapshot):
            raise FileNotFoundError(snapshot)
        return self.directory / snapshot

    def manifest(self, snapshot: str) -> dict:
        return json.loads((self.location(snapshot) / "manifest.json").read_text())

    def graph(self, snapshot: str) -> dict:
        self.manifest(snapshot)
        return json.loads((self.location(snapshot) / "graph.json").read_text())

    def source(self, snapshot: str, path: str, start: int, end: int | None = None, *, context: int = 0) -> dict:
        path = relative_path(path)
        manifest = self.manifest(snapshot)
        item = manifest["files"].get(path)
        if not item:
            raise FileNotFoundError(path)
        if not item["text"]:
            raise ValueError("This file has no UTF-8 source excerpt.")
        if start < 1 or (end is not None and (end < start or end - start >= 300)):
            raise ValueError("Select an inclusive range of at most 300 lines.")
        lines = read_source_lines(self.location(snapshot) / "source" / path)
        if end is None:
            end = min(len(lines), start + 39)
        if end > len(lines) or start > len(lines):
            raise ValueError(f"This file has {len(lines)} lines.")
        return {
            "path": path, "commit": manifest["commit"],
            "url": f"https://github.com/{manifest['repo']}/blob/{manifest['commit']}/{quote(path)}#L{start}-L{end}",
            "highlight": {"start": start, "end": end},
            "lines": [{"number": number, "text": lines[number - 1]}
                      for number in range(max(1, start - context), min(len(lines), end + context) + 1)],
        }

    def config_implementation(self, snapshot: str, citation: dict, *, context: int) -> dict | None:
        if PurePosixPath(citation["path"]).name not in {".env.example", ".env.sample", ".env.template"}:
            return None
        highlight = citation["highlight"]
        fallbacks = []
        for line in citation["lines"]:
            if not highlight["start"] <= line["number"] <= highlight["end"]:
                continue
            assignment = re.fullmatch(r"\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*([^#]{1,120})", line["text"])
            if assignment and (value := assignment[2].strip().strip("\"'")):
                fallbacks.append(re.compile(
                    rf"\b(config|env)\s*\.\s*{assignment[1]}\s*(?:\|\||\?\?)\s*(['\"]){re.escape(value)}\2"
                ))
        if not fallbacks:
            return None
        root = self.location(snapshot) / "source"
        remaining = 4 * 1024 * 1024
        environment_lookup = None
        for path, item in self.manifest(snapshot)["files"].items():
            if item["structure"] != "parsed" or item["size"] > remaining:
                continue
            remaining -= item["size"]
            for number, line in enumerate(read_source_lines(root / path), start=1):
                for pattern in fallbacks:
                    if match := pattern.search(line):
                        if match[1] == "config":
                            return self.source(snapshot, path, number, number, context=context)
                        environment_lookup = environment_lookup or (path, number)
        if environment_lookup:
            path, number = environment_lookup
            return self.source(snapshot, path, number, number, context=context)
        return None

    def capture(self, repo: str, commit: str, scope: str) -> dict:
        snapshot = scan_id(repo, commit, scope)
        target = self.location(snapshot)
        if (target / "manifest.json").is_file():
            return self.manifest(snapshot)
        with TemporaryDirectory(dir=self.directory) as temporary:
            work = Path(temporary)
            archive = work / "source.tar.gz"
            artifact = work / "snapshot"
            source = artifact / "source"
            source.mkdir(parents=True)
            download(repo, commit, archive)
            files = unpack(archive, source)
            if scope and not any(path.startswith(scope + "/") for path in files):
                raise ValueError("The selected directory is absent at this commit.")
            if scope:
                for path, item in files.items():
                    if item["text"] and not path.startswith(scope + "/"):
                        item["structure"] = "out-of-scope"
            result = artifact / "graph.json"
            selection = work / "selection.json"
            selection.write_text(json.dumps([
                path for path, item in files.items() if item["text"] and (
                    not scope or path.startswith(scope + "/")
                )
            ]))
            subprocess.run(
                [sys.executable, "-m", "codelineage.extract", str(source), str(selection), str(result)],
                check=True, timeout=900,
            )
            graph = json.loads(result.read_text())
            for path, status in graph.pop("coverage").items():
                files[path]["structure"] = status
            result.write_text(json.dumps(graph))
            manifest = {
                "id": snapshot, "repo": repo, "commit": commit, "scope": scope, "analyzer": ANALYZER,
                "coverage": {state: sum(row["structure"] == state for row in files.values())
                             for state in sorted({row["structure"] for row in files.values()})},
                "graphSha256": hashlib.sha256(result.read_bytes()).hexdigest(),
                "files": files,
            }
            (artifact / "manifest.json").write_text(json.dumps(manifest))
            try:
                artifact.rename(target)
            except OSError:
                if not (target / "manifest.json").is_file():
                    raise
        return self.manifest(snapshot)
