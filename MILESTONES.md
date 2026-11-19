# CodeLineage build milestones

The product contract and acceptance scenarios are in [Agora-Design-Decisions.md](Agora-Design-Decisions.md). Each milestone has a check that can be run from the application's normal entry points.

| Milestone | Delivery | Acceptance |
| --- | --- | --- |
| 1. Pinned evidence | Public GitHub intake, an isolated Graphify scan, a file manifest and source excerpts | Import the pinned Healthchecks release, read exact cited lines, repeat the scan and verify reuse. Check an unparsed text file in a mixed-language repository. |
| 2. Shared lineage | Evidence-backed findings, scoped claims and exceptions, commit comparison and scoped review baselines | Follow supported hops and find a shared decision across disconnected modules. Review a later commit and verify only completed scopes advance. |
| 3. Interview confirmation | Prepared topics, attributed turns and proposals, atomic revision writes and replayable events | Interrupt a read-back, correct the summary, reject stale approvals, retry a valid confirmation and verify that only one revision is written. |
| 4. Web experience | Two homepage actions, diagram and source panels, interview and read-only sessions | Review the panel state before and after confirmation. Open a fresh session and retrieve the reviewed decision with its provenance. |
| 5. Agora voice | Browser microphone, Agora Conversational AI and Murf Falcon, authenticated context and confirmation tools | Verify a real voice exchange, interruption and corrected read-back, then retrieve the saved rationale by voice in a fresh session. |
| 6. Deployment and handoff | Cloud Run service and scan job, private Cloud Storage, resumable Cloud Tasks, Neo4j, documented local and managed configuration | Exercise storage, task retry, database and UI checks. Run the pinned demo against the managed deployment. |

The demo uses Healthchecks v5.0.3 at `51a503531d845fc11d5ef270d576c59c300e3620`. The submission target is 21 November 2026 at 12:30 PM IST.

## Verification status

- The pinned Healthchecks import and cache reuse passed with real Graphify. The mixed-language fixture exercises readable text outside the parser coverage.
- Backend tests cover scoped retrieval, ordered relationships, returning reviews, interruption, stale approvals, single-revision replay, and fresh read-only sessions. Neo4j is exercised against a disposable real instance.
- Browser acceptance covers both text workflows and source attribution. The managed pipeline has local adapter and retry checks.
- Live Agora/Murf audio, spoken confirmation, and the managed GCP deployment are open acceptance items. Voice proposals currently require explicit confirmation in the browser.
