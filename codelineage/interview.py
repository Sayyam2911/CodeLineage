"""Session authorization, interview state transitions and revision receipts."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import secrets
from typing import Literal

from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from codelineage.knowledge import contains, head
from codelineage.snapshots import relative_path, repo_name

Mode = Literal["update", "understand"]
Operation = Literal["annotate", "add_component", "add_connection"]


class OpenSession(BaseModel):
    url: str = Field(max_length=300)
    mode: Mode
    snapshotId: str | None = None
    speaker: str = Field(default="Interview participant", min_length=1, max_length=100)


class Answer(BaseModel):
    text: str = Field(min_length=1, max_length=4000)
    scope: list[str] | None = Field(default=None, max_length=12)
    operation: Operation = "annotate"
    targetId: str | None = Field(default=None, max_length=300)
    relatedId: str | None = Field(default=None, max_length=300)
    label: str | None = Field(default=None, max_length=160)
    supersedes: str | None = Field(default=None, max_length=80)
    exceptionTo: str | None = Field(default=None, max_length=80)


class ProposalAction(BaseModel):
    proposalId: str
    readbackTurnId: str | None = None
    assentTurnId: str | None = None


class Question(BaseModel):
    text: str = Field(min_length=1, max_length=2000)
    targetId: str | None = Field(default=None, max_length=300)


def token_digest(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def event(records, session: dict, kind: str, **payload) -> None:
    session["seq"] += 1
    session_id = session["id"]
    seq = session["seq"]
    records.put(f"events:{session_id}", f"{seq:012d}", {
        "eventId": f"{session_id}:{seq}", "seq": seq, "type": kind, "sessionId": session_id,
        "snapshotId": session["snapshotId"], "revision": session["revision"], **payload,
    })


def turn(records, session: dict, role: str, text: str, **metadata) -> dict:
    session["turnSeq"] += 1
    item = {"id": secrets.token_hex(12), "seq": session["turnSeq"], "speaker": role,
            "text": text, "status": "final", **metadata}
    records.put(f"turns:{session['id']}", item["id"], item)
    event(records, session, "turn.finalized", turn=item)
    return item


class Interviews:
    def __init__(self, knowledge):
        self.knowledge = knowledge
        self.database = knowledge.database
        self.snapshots = knowledge.snapshots

    @staticmethod
    def authorize(records, session_id: str, authorization: str, *, voice: bool = False) -> dict:
        session = records.get("sessions", session_id)
        scheme, _, token = authorization.partition(" ")
        connection = records.get("voice", session_id) if voice else None
        expected = connection["toolHash"] if voice and connection else session["tokenHash"] if not voice and session else ""
        if not session or scheme.lower() != "bearer" or not hmac.compare_digest(expected, token_digest(token)):
            raise HTTPException(401, "A valid session token is required.")
        return session

    @staticmethod
    def writable(session: dict) -> None:
        if session["mode"] != "update":
            raise HTTPException(403, "Understand sessions are read-only.")
        if session["finished"]:
            raise HTTPException(409, "This review has already finished.")

    @staticmethod
    def public(session: dict) -> dict:
        return {key: value for key, value in session.items() if key not in {"tokenHash", "turnSeq"}}

    def open(self, request: OpenSession) -> dict:
        try:
            repo = repo_name(request.url)
            with self.database.transaction() as records:
                state = head(records, repo)
            if request.mode == "understand":
                id_ = state["snapshotId"]
                if id_ is None:
                    raise HTTPException(404, "No reviewed lineage yet. Choose Create or update code lineage.")
            else:
                id_ = request.snapshotId
                if not id_:
                    raise HTTPException(422, "Choose a scanned snapshot.")
            manifest = self.snapshots.manifest(id_)
            if manifest["repo"] != repo:
                raise HTTPException(422, "The snapshot belongs to a different repository.")
        except FileNotFoundError as exc:
            raise HTTPException(404, "Snapshot not found.") from exc
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        topics = self.knowledge.topics(id_) if request.mode == "update" else []
        token = secrets.token_urlsafe(32)
        session = {
            "id": secrets.token_hex(16), "tokenHash": token_digest(token),
            "repo": repo, "snapshotId": id_, "mode": request.mode,
            "speaker": request.speaker.strip() or "Interview participant", "topics": topics,
            "index": 0, "seq": 0, "turnSeq": 0, "revision": state["revision"],
            "pending": None, "outcomes": {}, "finished": False, "snapshotScope": manifest["scope"],
        }
        with self.database.transaction(write=True) as records:
            event(records, session, "session.opened")
            records.put("sessions", session["id"], session)
        return self.public(session) | {"token": token}

    @staticmethod
    def retire(records, session: dict, status: str) -> None:
        if pending := session["pending"]:
            pending["status"] = status
            records.put(f"proposals:{session['id']}", pending["id"], pending)
            session["pending"] = None
            event(records, session, f"proposal.{status}", proposalId=pending["id"])

    def stage(self, session_id: str, auth: str, request: Answer, *, voice_answer: str | None = None) -> dict:
        with self.database.transaction() as records:
            session = self.authorize(records, session_id, auth, voice=voice_answer is not None)
            self.writable(session)
            topic = self.active_topic(session)
        answer = request.text.strip()
        if not answer:
            raise HTTPException(422, "Enter a reason or skip the question.")
        if answer.lower().rstrip(".!?") in {"i don't know", "i don’t know", "not sure", "unknown"}:
            if voice_answer is not None:
                raise HTTPException(422, "An unresolved answer does not create a proposal.")
            return self.skip(session_id, auth, topic["id"], answer)
        scopes = request.scope or [topic["scope"]]
        graph = self.knowledge.projection(session["snapshotId"], session["revision"])
        files = self.snapshots.manifest(session["snapshotId"])["files"]
        try:
            if any(not any(contains(relative_path(scope), path) for path in files) for scope in scopes):
                raise ValueError("Every scope must name a file or directory in the snapshot.")
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        if any(not contains(session["snapshotScope"], scope) for scope in scopes):
            raise HTTPException(422, "Each scope must stay within the scanned directory.")
        target = request.targetId or topic["targetId"]
        targets = {node["id"] for node in graph["nodes"]}
        claim_ids = {claim["claimId"] for claim in graph["claims"]}
        if request.operation == "add_component":
            target = "confirmed-" + secrets.token_hex(12)
        if request.operation == "add_connection" and (target not in targets or request.relatedId not in targets):
            raise HTTPException(422, "Select two existing components for the connection.")
        if request.operation == "annotate" and target and target not in targets:
            raise HTTPException(422, "The selected component is absent at this revision.")
        if request.operation != "annotate" and not (request.label and request.label.strip()):
            raise HTTPException(422, "Enter a label for the structural change.")
        if any(id_ and id_ not in claim_ids for id_ in (request.supersedes, request.exceptionTo)):
            raise HTTPException(422, "The referenced claim is absent at this revision.")
        if request.supersedes and request.supersedes == request.exceptionTo:
            raise HTTPException(422, "A claim cannot supersede its own exception target.")
        # The typed client explicitly displays this same text and scope before approval.
        statement = " ".join(answer.split())
        details = [f"Scope: {', '.join(scopes)}"]
        node_labels = {node["id"]: node["label"] for node in graph["nodes"]}
        if request.operation == "add_component":
            details.append(f"Add component {request.label.strip()}")
        elif request.operation == "add_connection":
            details.append(f"Add {node_labels[target]} → {node_labels[request.relatedId]} ({request.label.strip()})")
        elif target:
            details.append(f"Target: {node_labels[target]}")
        if request.supersedes:
            details.append("Supersede " + next(c["title"] for c in graph["claims"] if c["claimId"] == request.supersedes))
        if request.exceptionTo:
            details.append("Exception to " + next(c["title"] for c in graph["claims"] if c["claimId"] == request.exceptionTo))
        summary = statement + "\n" + " · ".join(details)
        with self.database.transaction(write=True) as records:
            session = self.authorize(records, session_id, auth, voice=voice_answer is not None)
            self.writable(session)
            if self.active_topic(session)["id"] != topic["id"] or session["revision"] != graph["revision"]:
                raise HTTPException(409, "The review moved to a different topic or revision.")
            self.retire(records, session, "superseded")
            originating = turn(records, session, "participant", voice_answer or answer, purpose="answer")
            proposal = {
                "id": secrets.token_hex(16), "status": "pending", "topicId": topic["id"],
                "title": topic["title"], "statement": statement, "summary": summary, "scopes": scopes,
                "operation": request.operation, "label": request.label, "relatedId": request.relatedId,
                "targetId": target, "baseRevision": session["revision"], "exceptionTo": request.exceptionTo,
                "answerTurnId": originating["id"], "readbackTurnId": None, "supersedes": request.supersedes,
                "evidence": topic["evidence"],
            }
            session["pending"] = proposal
            records.put(f"proposals:{session_id}", proposal["id"], proposal)
            event(records, session, "proposal.pending", proposal=proposal)
            records.put("sessions", session_id, session)
            return self.public(session)

    @staticmethod
    def active_topic(session: dict) -> dict:
        if session["index"] >= len(session["topics"]):
            raise HTTPException(409, "The review has no remaining topics.")
        return session["topics"][session["index"]]

    def skip(self, session_id: str, auth: str, expected_topic: str | None = None, answer: str | None = None) -> dict:
        with self.database.transaction(write=True) as records:
            session = self.authorize(records, session_id, auth)
            self.writable(session)
            topic = self.active_topic(session)
            if expected_topic is not None and topic["id"] != expected_topic:
                raise HTTPException(409, "The review moved to a different topic.")
            self.retire(records, session, "withdrawn")
            if answer:
                turn(records, session, "participant", answer, purpose="unknown")
            session["outcomes"][topic["id"]] = "open"
            session["index"] += 1
            event(records, session, "topic.open", topicId=topic["id"])
            records.put("sessions", session_id, session)
            return self.public(session)

    def readback(self, session_id: str, auth: str, proposal_id: str) -> dict:
        with self.database.transaction(write=True) as records:
            session = self.authorize(records, session_id, auth)
            self.writable(session)
            proposal = session["pending"]
            if not proposal or proposal["id"] != proposal_id:
                raise HTTPException(409, "This proposal is no longer active.")
            if not proposal["readbackTurnId"]:
                rendered = turn(records, session, "assistant", proposal["summary"], purpose="readback",
                                proposalId=proposal_id)
                proposal["readbackTurnId"] = rendered["id"]
                event(records, session, "proposal.readback", proposalId=proposal_id)
                records.put(f"proposals:{session_id}", proposal_id, proposal)
                records.put("sessions", session_id, session)
            return self.public(session)

    def interrupt(self, session_id: str, auth: str, proposal_id: str) -> dict:
        with self.database.transaction(write=True) as records:
            session = self.authorize(records, session_id, auth)
            self.writable(session)
            proposal = session["pending"]
            if not proposal or proposal["id"] != proposal_id:
                raise HTTPException(409, "This proposal is no longer active.")
            self.retire(records, session, "interrupted")
            event(records, session, "readback.interrupted")
            records.put("sessions", session_id, session)
            return self.public(session)

    def confirm(self, session_id: str, auth: str, action: ProposalAction, *, typed: bool = True) -> dict:
        with self.database.transaction(write=True) as records:
            session = self.authorize(records, session_id, auth)
            if session["mode"] != "update":
                raise HTTPException(403, "Understand sessions are read-only.")
            if receipt := records.get(f"receipts:{session_id}", action.proposalId):
                if (receipt["readbackTurnId"] != action.readbackTurnId
                        or not typed and receipt["assentTurnId"] != action.assentTurnId):
                    raise HTTPException(409, "The confirmation does not match the recorded receipt.")
                return receipt
            self.writable(session)
            proposal = session["pending"]
            if not proposal or proposal["id"] != action.proposalId:
                raise HTTPException(409, "This proposal is no longer active.")
            namespace = f"turns:{session_id}"
            readback = records.get(namespace, action.readbackTurnId or "")
            origin = records.get(namespace, proposal["answerTurnId"])
            if (not readback or proposal["readbackTurnId"] != readback["id"] or
                    readback["status"] != "final" or readback["speaker"] != "assistant"
                    or readback["purpose"] != "readback" or readback["text"] != proposal["summary"]
                    or not origin or origin["seq"] >= readback["seq"]):
                raise HTTPException(409, "Complete the active read-back before confirming.")
            state = head(records, session["repo"])
            if state["revision"] != proposal["baseRevision"]:
                raise HTTPException(409, "The shared graph changed. Open a new review to confirm against the latest revision.")
            if typed:
                assent = turn(records, session, "participant", "I approve this exact summary.", purpose="assent",
                              proposalId=proposal["id"])
            else:
                assent = records.get(namespace, action.assentTurnId or "")
                if (not assent or assent["status"] != "final" or assent["speaker"] != "participant"
                        or assent.get("purpose") != "assent" or assent.get("proposalId") != proposal["id"]
                        or assent["seq"] != session["turnSeq"] or assent["seq"] <= readback["seq"]):
                    raise HTTPException(409, "A finalized participant assent is required after the active read-back.")
            event(records, session, "revision.applying", proposalId=proposal["id"])
            revision = state["revision"] + 1
            claim_id = proposal["supersedes"] or secrets.token_hex(12)
            claim = {key: proposal[key] for key in (
                "statement", "title", "scopes", "operation", "label", "relatedId", "targetId",
                "exceptionTo", "topicId", "answerTurnId",
            )}
            claim.update({
                "claimId": claim_id, "revision": revision, "snapshotId": session["snapshotId"],
                "origin": "interview", "speaker": session["speaker"], "sessionId": session_id,
                "evidence": [*proposal["evidence"], {
                    "kind": "interview", "sessionId": session_id, "turnId": origin["id"],
                    "speaker": session["speaker"], "text": origin["text"],
                }],
            })
            records.put(f"claims:{session['repo']}", f"{revision:012d}:{claim_id}", claim)
            proposal["status"] = "committed"
            records.put(f"proposals:{session_id}", proposal["id"], proposal)
            receipt = {"proposalId": proposal["id"], "readbackTurnId": readback["id"],
                       "assentTurnId": assent["id"], "revision": revision, "claim": claim}
            records.put(f"receipts:{session_id}", proposal["id"], receipt)
            session["latestReceipt"] = receipt
            state.update(revision=revision, snapshotId=session["snapshotId"])
            records.put("lineage", session["repo"], state)
            session["revision"] = revision
            session["pending"] = None
            session["outcomes"][proposal["topicId"]] = "confirmed"
            session["index"] += 1
            event(records, session, "revision.committed", receipt=receipt)
            records.put("sessions", session_id, session)
            return receipt

    def finish(self, session_id: str, auth: str) -> dict:
        with self.database.transaction(write=True) as records:
            session = self.authorize(records, session_id, auth)
            if session["finished"]:
                return self.public(session)
            if session["mode"] == "update":
                self.retire(records, session, "withdrawn")
                state = head(records, session["repo"])
                if state["revision"] != session["revision"]:
                    raise HTTPException(409, "The lineage changed since this review started.")
                closed = {topic["scope"] for topic in session["topics"]
                          if session["outcomes"].get(topic["id"]) == "confirmed"}
                unreviewed = {topic["scope"] for topic in session["topics"]
                              if session["outcomes"].get(topic["id"]) != "confirmed"}
                for scope in closed:
                    if not any(contains(scope, path) or contains(path, scope) for path in unreviewed):
                        state["baselines"][scope] = session["snapshotId"]
                records.put("lineage", session["repo"], state)
            session["finished"] = True
            event(records, session, "session.finished")
            records.put("sessions", session_id, session)
            return self.public(session)


def interview_routes(service: Interviews) -> APIRouter:
    router = APIRouter(prefix="/sessions")

    @router.post("", status_code=201)
    def open_session(body: OpenSession):
        return service.open(body)

    def current(session_id: str, auth: str) -> dict:
        with service.database.transaction() as records:
            return service.public(service.authorize(records, session_id, auth))

    @router.get("/{session_id}")
    def get_session(session_id: str, authorization: str = Header(default="")):
        return current(session_id, authorization)

    @router.get("/{session_id}/turns")
    def get_turns(session_id: str, authorization: str = Header(default="")):
        with service.database.transaction() as records:
            service.authorize(records, session_id, authorization)
            rows = records.items(f"turns:{session_id}")
        return sorted((row for _, row in rows), key=lambda row: row["seq"])

    @router.post("/{session_id}/answer")
    def answer(session_id: str, body: Answer, authorization: str = Header(default="")):
        return service.stage(session_id, authorization, body)

    @router.post("/{session_id}/readback")
    def readback(session_id: str, body: ProposalAction, authorization: str = Header(default="")):
        return service.readback(session_id, authorization, body.proposalId)

    @router.post("/{session_id}/interrupt")
    def interrupt(session_id: str, body: ProposalAction, authorization: str = Header(default="")):
        return service.interrupt(session_id, authorization, body.proposalId)

    @router.post("/{session_id}/confirm")
    def confirm(session_id: str, body: ProposalAction, authorization: str = Header(default="")):
        return service.confirm(session_id, authorization, body)

    @router.post("/{session_id}/skip")
    def skip(session_id: str, authorization: str = Header(default="")):
        return service.skip(session_id, authorization)

    @router.post("/{session_id}/finish")
    def finish(session_id: str, authorization: str = Header(default="")):
        return service.finish(session_id, authorization)

    @router.post("/{session_id}/context")
    def context(session_id: str, body: Question, authorization: str = Header(default="")):
        session = current(session_id, authorization)
        return service.knowledge.context(session["snapshotId"], body.text, body.targetId, session["revision"])

    @router.get("/{session_id}/events")
    async def events(session_id: str, request: Request, after: int = 0, wait: bool = True,
                     authorization: str = Header(default=""), last_event_id: str = Header(default="")):
        current(session_id, authorization)
        cursor = max(0, after)
        if last_event_id:
            event_session, _, sequence = last_event_id.partition(":")
            if event_session != session_id or not sequence.isascii() or not sequence.isdecimal():
                raise HTTPException(422, "The event cursor does not belong to this session.")
            cursor = max(cursor, int(sequence))

        async def stream():
            nonlocal cursor
            for _ in range(40 if wait else 1):
                if await request.is_disconnected():
                    return
                with service.database.transaction() as records:
                    pending = [row for _, row in records.items(f"events:{session_id}") if row["seq"] > cursor]
                for row in pending:
                    cursor = row["seq"]
                    yield f"id: {row['eventId']}\nevent: {row['type']}\ndata: {json.dumps(row)}\n\n"
                if not wait:
                    return
                await asyncio.sleep(0.5)

        return StreamingResponse(stream(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    return router
