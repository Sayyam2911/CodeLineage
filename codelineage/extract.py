"""Graphify subprocess entry point. Repository files are inputs, never commands."""

import json
import re
import sys
from pathlib import Path

from graphify.extract import _get_extractor, extract

from codelineage.snapshots import relative_path


def run(root: Path, selection: Path, output: Path) -> None:
    root = root.resolve()
    paths = [root / relative_path(path) for path in json.loads(selection.read_text())]
    supported = [path for path in paths if _get_extractor(path) is not None]
    raw = extract(supported, root=root, cache_root=selection.parent, parallel=False) if supported else {}
    coverage = {path.relative_to(root).as_posix(): "parsed" for path in supported}
    for key, status in (("failed_sources", "failed"), ("skipped_sources", "unparsed")):
        for path in raw.get(key, []):
            relative = Path(path).relative_to(root).as_posix()
            coverage[relative] = status

    def source(item: dict) -> tuple[str | None, int | None, int | None]:
        path = item.get("source_file")
        if path not in coverage:
            return None, None, None
        line = re.fullmatch(r"L?(\d+)(?:-L?(\d+))?", str(item.get("source_location") or ""))
        if not line:
            return path, None, None
        return path, int(line[1]), int(line[2] or line[1])

    nodes = {}
    for item in raw.get("nodes", []):
        path, start, end = source(item)
        if path is not None:
            nodes[item["id"]] = {"id": item["id"], "label": item.get("label") or item["id"],
                                 "path": path, "start": start, "end": end, "origin": "extracted"}
    edges = []
    for item in raw.get("edges", []):
        if item["source"] in nodes and item["target"] in nodes:
            path, start, end = source(item)
            confidence = str(item.get("confidence") or "inferred").lower()
            edges.append({"source": item["source"], "target": item["target"],
                          "relation": item.get("relation") or "related",
                          "origin": "extracted" if confidence == "extracted" and start else "inferred",
                          "confidence": item.get("confidence_score"),
                          "path": path, "start": start, "end": end})
    output.write_text(json.dumps({"nodes": list(nodes.values()), "edges": edges, "coverage": coverage}))


if __name__ == "__main__":
    run(*(Path(arg) for arg in sys.argv[1:]))
