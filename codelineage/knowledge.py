"""Snapshot findings, scoped review baselines and evidence-grounded retrieval."""

import hashlib
import re
from collections import defaultdict, deque
from urllib.parse import quote

from codelineage.snapshots import DEMO_COMMIT, DEMO_REPO


def stable_id(*parts: str) -> str:
    return hashlib.sha256("\0".join(parts).encode()).hexdigest()[:24]


def head(records, repo: str) -> dict:
    return records.get("lineage", repo, {"revision": 0, "snapshotId": None, "baselines": {}})


def contains(scope: str, path: str) -> bool:
    return not scope or path == scope or path.startswith(scope + "/")


def evidence(snapshot: str, path: str, start: int, end: int) -> dict:
    return {"kind": "source", "snapshotId": snapshot, "path": path, "start": start, "end": end}


def terms(text: str) -> set[str]:
    return set(re.findall(r"[a-z0-9]{3,}", text.lower())) - {
        "about", "and", "does", "for", "how", "the", "what", "when", "where", "which", "why", "with",
    }


class Knowledge:
    def __init__(self, snapshots, database):
        self.snapshots = snapshots
        self.database = database

    def prepare(self, snapshot: str) -> dict:
        with self.database.transaction() as records:
            cached = records.get("findings", snapshot)
            if cached:
                return cached
        manifest = self.snapshots.manifest(snapshot)
        graph = self.snapshots.graph(snapshot)
        scope = manifest["scope"]
        findings = []
        covered = set()
        if manifest["repo"] == DEMO_REPO and manifest["commit"] == DEMO_COMMIT and contains(scope, "hc/api/models.py"):
            path = "hc/api/models.py"
            excerpts = [evidence(snapshot, path, 1407, 1409), evidence(snapshot, path, 1179, 1185)]
            for excerpt in excerpts:
                self.snapshots.source(snapshot, path, excerpt["start"], excerpt["end"])
            target = next((n["id"] for n in graph["nodes"]
                           if n["path"] == path and n["start"] and abs(n["start"] - 1407) < 4), None)
            findings.append({
                "id": stable_id(snapshot, "alert-ordering"), "title": "Alert delivery order",
                "statement": "Eligible channels are ordered by recorded delivery duration, with unmeasured channels last.",
                "question": "What trade-off does your deployment accept when a new channel has no delivery history?",
                "origin": "code", "scope": path, "targetId": target, "evidence": excerpts,
                "priority": 100,
            })
            covered.add(path)

        nodes = {node["id"]: node for node in graph["nodes"]}
        for edge in graph["edges"]:
            if len(findings) >= 50:
                break
            path, line = edge["path"], edge["start"]
            if edge["origin"] != "extracted" or not path or not line or path in covered:
                continue
            start, end = line, min(edge["end"] or line, line + 11)
            try:
                self.snapshots.source(snapshot, path, start, end)
            except (ValueError, FileNotFoundError):
                continue
            left, right = nodes[edge["source"]], nodes[edge["target"]]
            covered.add(path)
            findings.append({
                "id": stable_id(snapshot, path, str(line)), "title": f"{left['label']} → {right['label']}",
                "statement": f"Graphify extracted a {edge['relation']} relationship between {left['label']} and {right['label']}.",
                "question": f"What design decision explains this {edge['relation']} relationship, and where should that rationale apply?",
                "origin": "structure", "scope": path, "targetId": left["id"],
                "evidence": [evidence(snapshot, path, start, end)], "priority": 10,
            })
        result = {"mode": "local", "items": findings, "reviewedPaths": sorted(covered)}
        with self.database.transaction(write=True) as records:
            previous = records.get("findings", snapshot)
            if previous:
                return previous
            records.put("findings", snapshot, result)
        return result

    def compare(self, snapshot: str, baseline: str | None = None) -> dict:
        current = self.snapshots.manifest(snapshot)
        with self.database.transaction() as records:
            state = head(records, current["repo"])
            applicable = [(scope, value) for scope, value in state["baselines"].items()
                          if contains(scope, current["scope"])]
            if not baseline and applicable:
                baseline = max(applicable, key=lambda pair: len(pair[0]))[1]
            claims = self.claims(records, current["repo"], state["revision"])
        result = {"baseline": baseline, "snapshotId": snapshot, "changedPaths": [],
                  "affectedPaths": [], "priorClaims": [], "wideReview": False}
        if not baseline:
            return result
        previous = self.snapshots.manifest(baseline)
        if previous["repo"] != current["repo"]:
            raise ValueError("The baseline belongs to a different repository.")
        old, new = previous["files"], current["files"]
        changed = {path for path in old.keys() | new.keys()
                   if contains(current["scope"], path) and
                   (old.get(path) or {}).get("sha256", old.get(path)) !=
                   (new.get(path) or {}).get("sha256", new.get(path))}
        old_graph, current_graph = self.snapshots.graph(baseline), self.snapshots.graph(snapshot)
        affected = set(changed)
        for graph in (old_graph, current_graph):
            nodes = {item["id"]: item["path"] for item in graph["nodes"]}
            for edge in graph["edges"]:
                if nodes.get(edge["target"]) in changed and nodes.get(edge["source"]):
                    affected.add(nodes[edge["source"]])
        matching = [claim for claim in claims if any(
            contains(claim_scope, path) for claim_scope in claim["scopes"] for path in affected
        )]
        for claim in matching:
            affected.update(path for path in new if any(contains(s, path) for s in claim["scopes"]))
        return result | {"changedPaths": sorted(changed), "affectedPaths": sorted(affected),
                         "priorClaims": matching, "wideReview": len(changed) > max(20, len(new) // 3)}

    @staticmethod
    def claims(records, repo: str, revision: int) -> list[dict]:
        current = {}
        for _, claim in records.items(f"claims:{repo}"):
            prior = current.get(claim["claimId"])
            if claim["revision"] <= revision and (not prior or claim["revision"] > prior["revision"]):
                current[claim["claimId"]] = claim
        return list(current.values())

    def projection(self, snapshot: str, revision: int | None) -> dict:
        manifest = self.snapshots.manifest(snapshot)
        repo = manifest["repo"]
        graph = self.snapshots.graph(snapshot)
        with self.database.transaction() as records:
            latest = head(records, repo)["revision"]
            revision = latest if revision is None else revision
            if revision < 0 or revision > latest:
                raise ValueError("Unknown graph revision.")
            claims = self.claims(records, repo, revision)
        nodes = {row["id"]: row for row in graph["nodes"]}
        edges = list(graph["edges"])
        for claim in claims:
            if claim["snapshotId"] != snapshot:
                continue
            operation = claim["operation"]
            target = claim["targetId"]
            if operation == "add_component":
                nodes[target] = {"id": target, "label": claim["label"], "origin": "interview",
                                 "path": None, "start": None, "end": None}
            elif operation == "add_connection":
                edges.append({"source": target, "target": claim["relatedId"],
                              "relation": claim["label"], "origin": "interview", "claimId": claim["claimId"]})
        return {"nodes": list(nodes.values()), "edges": edges, "claims": claims,
                "revision": revision, "snapshotId": snapshot}

    def topics(self, snapshot: str) -> list[dict]:
        findings = self.prepare(snapshot)["items"]
        review = self.compare(snapshot)
        affected = set(review["affectedPaths"])
        repo = self.snapshots.manifest(snapshot)["repo"]
        with self.database.transaction() as records:
            state = head(records, repo)
            answered = {claim.get("topicId") for claim in self.claims(records, repo, state["revision"])}
        return sorted((item for item in findings if item["id"] not in answered),
                      key=lambda item: (item["scope"] in affected, item["priority"]), reverse=True)

    def context(self, snapshot: str, question: str = "", target: str | None = None,
                revision: int | None = None) -> dict:
        graph = self.projection(snapshot, revision)
        query = terms(question)
        nodes = {node["id"]: node for node in graph["nodes"]}
        ranked = sorted(nodes.values(), key=lambda node: len(query & terms(node["label"])), reverse=True)
        focus = nodes.get(target) if target else None
        if focus is None and ranked and query & terms(ranked[0]["label"]):
            focus = ranked[0]
        paths = {focus["path"]} if focus and focus["path"] else set()
        hops = []
        if focus:
            outgoing = defaultdict(list)
            for edge in graph["edges"]:
                if edge["origin"] in {"extracted", "interview"}:
                    outgoing[edge["source"]].append(edge)
            queue = deque([(focus["id"], [])])
            visited = {focus["id"]}
            while queue:
                node_id, chain = queue.popleft()
                if len(chain) > len(hops):
                    hops = chain
                if len(chain) == 5:
                    break
                for edge in outgoing[node_id]:
                    if edge["target"] not in visited and edge["target"] in nodes:
                        visited.add(edge["target"])
                        queue.append((edge["target"], chain + [edge | {
                            "fromLabel": nodes[node_id]["label"], "toLabel": nodes[edge["target"]]["label"],
                        }]))
            paths.update(nodes[hop["target"]]["path"] for hop in hops if nodes[hop["target"]]["path"])

        def score(item: dict) -> int:
            text = " ".join([item.get("title", ""), item["statement"], *item.get("scopes", [])])
            scopes = item.get("scopes") or [item["scope"]]
            return len(query & terms(text)) + 6 * any(contains(s, p) for s in scopes for p in paths)

        claims = sorted((item for item in graph["claims"] if score(item)), key=score, reverse=True)[:8]
        findings = sorted((item for item in self.prepare(snapshot)["items"] if score(item)),
                          key=score, reverse=True)[:5]
        citations = []
        for item in [*claims, *findings]:
            for ref in item["evidence"]:
                if ref not in citations:
                    citations.append(ref)
        if focus and focus["path"] and focus["start"]:
            citations.append(evidence(snapshot, focus["path"], focus["start"],
                                      min(focus["end"] or focus["start"], focus["start"] + 29)))
        manifest = self.snapshots.manifest(snapshot)
        docs = [path for path, item in manifest["files"].items()
                if item["text"] and path.lower().endswith((".md", ".rst", ".adoc"))]
        documents = sorted(
            (path for path in docs if query & terms(path)), key=lambda path: len(query & terms(path)), reverse=True
        )[:3]
        return {"focus": focus, "claims": claims, "findings": findings, "hops": hops, "evidence": citations,
                "documents": [{"path": path, "url": f"https://github.com/{manifest['repo']}/blob/{manifest['commit']}/{quote(path)}"}
                              for path in documents],
                "unknown": not bool(claims), "revision": graph["revision"]}
