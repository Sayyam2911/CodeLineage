# Build with Agora Bengaluru 2026 — Architecture interview assistant

Design checkpoint · 19 November 2026 · Phase 1

**Submission target:** 21 November 2026 at 12:30 PM IST. Solo project for Track 2, “Voice AI at Work: Beyond the Call Center.” [Hackathon brief](https://www.commudle.com/communities/knotic/hackathons/build-with-agora-blr/tracks)

## Product and working agreement

A maintainer connects a repository. The app maps the architecture, reads the code and documentation, and identifies consequential decisions whose rationale is still unclear. A voice agent interviews the maintainer while the diagram and relevant source lines are visible. A second developer can open a fresh session and retrieve the reviewed explanation from the shared knowledge base.

Design proceeds one major decision at a time, with architecture and low-level design ahead of demo and presentation planning. This is a checkpoint. After the remaining decisions, present one consolidated blueprint. Implementation begins when the user approves it and says **“Start building.”** Then implement and verify the agreed application in one pass. If credentials are missing, continue independent work and identify the blocked verification.

## Approved decisions

| # | Decision | Reason |
|---|---|---|
| 1 | Use a modular monolith for the application backend. Decision 8 moves static extraction into a separate execution of a Cloud Run Job. | Keeps interview state and knowledge management together while isolating repository scans. |
| 2 | Use Graphify for code structure, an LLM to interpret the repository, and Neo4j for the shared knowledge base. Adapt the evidence and documentation-gap approach from architecture-skills. | Capture the reason behind a choice, where it applies, and what remains unknown, including across disconnected modules. |
| 3 | Prepare interview topics from unresolved findings. Allow adaptive follow-ups. | Every topic has source evidence. A follow-up is worthwhile when it could change the rationale, scope, exception, or affected components we record. |
| 4 | Support annotations and proposed component or connection changes. Ask for confirmation of the agent’s deduction before changing either panel. | The engineer can correct a misunderstanding before it appears in the architecture. |
| 5 | Use Agora Conversational AI, Murf Falcon TTS, and direct HTTPS tools exposed by the backend. | Direct tools keep context lookup and diagram updates within the existing deployment. MCP can be reconsidered if a new consumer or integration need arises. |
| 6 | Diagram on the left, code on the right, voice below. Show progress at the top of each panel while applying a confirmed change. | The maintainer can inspect the question’s evidence and see exactly what changed after confirmation. |
| 7 | Accept a public GitHub repository URL and resolve it to a commit SHA. | The scan and source citations refer to the same reproducible snapshot. |
| 8 | Run snapshot capture and Graphify in a Cloud Run Job, then perform semantic analysis and persist validated findings in the backend. | The analyzer retains access to the whole commit and to prior decisions after the scan job exits. |

**MVP output.** A reviewed decision becomes available to other developers through the shared graph. An earlier concept ended with a Markdown decision record and a GitHub draft PR. The agreed MVP ends with the reusable graph entry. This Markdown file is a planning checkpoint requested by the project owner.

## How knowledge is created and retrieved

1. Pin each repository analysis to a commit. Graphify produces a structural map in `graph.json`. Preserve source locations, relationship direction, and the distinction between extracted and inferred relationships.
2. Run a separate LLM analysis stage over the relevant code, tests, configuration, comments, READMEs, and existing decision records. Verify the exact statements behind each question at the pinned commit. A function definition alone may be too broad to support a behavioral claim.
3. Store observations, candidate decisions, affected components, exceptions, source references, open questions, and maintainer explanations in Neo4j. Each significant claim carries its source and status. A correction can supersede an earlier interpretation while preserving its history.
4. A shared decision may govern two modules with no call path between them. Similar implementations can suggest a connection. Evidence or maintainer confirmation establishes its scope. A confirmed exception belongs to its specific component. If code and stated intent disagree, preserve both accounts.
5. Give the agent a backend context lookup that retrieves relevant paths, decisions, documents, and exceptions. For a five-function chain, return the supported hops in order and identify uncertain links. Related documentation may sit outside the chain. Semantic search remains an optional way to find candidate connections.

**Question selection.** Ask what a future engineer might change and which missing information could affect that choice. Skip questions the reviewed material already answers. “I don’t know” leaves the rationale open.

## Interview and screen behavior

1. Open the current topic, highlight its diagram element, and show the exact source lines for the question. Put the current speaker, question, and voice controls below the two panels. The full transcript can expand there.
2. Listen to the engineer’s full answer. State the deduction in **one or two lines**, including its scope when relevant. Ask for explicit confirmation. Keep the diagram and evidence panel in their prior state during this exchange.
3. If the engineer corrects the deduction, revise it and ask again. A pause, interruption, skipped question, or “I don’t know” cannot confirm a change. The pending summary can be shown in the voice area.
4. After confirmation, apply the reviewed update and show progress at the top of both panels. The diagram indicator describes the annotation or structural update. The code indicator describes refreshing the evidence or highlighted lines. Repository source stays read-only.
5. Display the revised diagram with stable positions around the affected element. Label a maintainer-only claim with its attribution. Where matching code exists, show the supporting lines too. If saving or loading evidence fails, report the outcome accurately.
6. A developer in a new session can retrieve the confirmed explanation, its scope, and its sources.

**Latest revision.** Earlier sketches showed a draft annotation or a dashed connection on the diagram before confirmation. The approved sequence keeps the proposal in the conversation until the engineer confirms it. This applies to annotations, components, and connections.

### Example to carry forward

The code shows that signup queues a welcome email. The maintainer explains that a slow provider once delayed signup. The agent asks, “I understood that welcome emails run in the background so provider delays don’t hold up signup. Should I record that for welcome emails?” On confirmation, the diagram gains that rationale and the code panel highlights the enqueue operation. The code supports the observed behavior. The interview supports the reason. A future developer can ask what would happen if the email were sent inline and recover both sources. This example illustrates the flow. The demo repository is still open.

## Integration notes

Agora runs the voice session and can call synchronous HTTPS tools on our backend. Murf supplies Falcon speech using a project-owned Murf API key. Illustrative tool names include `getDecisionContext` and `proposeDiagramChange`. The blueprint still needs to specify how confirmation binds to the exact proposal, how retries avoid duplicate writes, and how the browser receives the update. Official documentation was reviewed during design. Actual credentials, audio, interruption handling, and tool execution still need build-time verification.

[Graphify](https://github.com/Graphify-Labs/graphify) · [architecture-skills](https://github.com/cdvel/architecture-skills) · [Neo4j property graph model](https://neo4j.com/docs/getting-started/appendix/graphdb-concepts/) · [Agora custom tools](https://docs.agora.io/en/ai/platform/build/tools/custom-tools) · [Agora Murf integration](https://docs.agora.io/en/ai/platform/models/tts/murf) · [Murf streaming TTS](https://murf.ai/api/docs/text-to-speech/overview)

## Checks to carry into the blueprint

- A question opens the precise source lines that support it. The app distinguishes code evidence, an inference, a maintainer’s explanation, and an open question.
- A five-function path can be followed through verified links. A relevant document outside the path is discoverable. A disconnected module retrieves a confirmed shared decision and its own exception.
- Before confirmation, an answer can be corrected without changing either panel. After confirmation, both panels show progress, the intended change is applied once, and matching evidence or attribution is visible.
- A fresh session can retrieve the reviewed explanation. Skipped or unknown answers remain unresolved.

## Repository processing

1. The Cloud Run Job fetches the pinned public commit. Its image supplies Graphify and the parser dependencies. It reads the submitted project's source without installing its packages or executing its scripts. It saves the complete source snapshot and scan index in private Cloud Storage.
2. After those artifacts are complete, the backend analysis agent reads the index, opens and searches full files, checks documentation, and retrieves relevant repository knowledge from Neo4j. An existing complete scan can be reused.
3. The backend validates the findings and writes them to Neo4j with commit, scope, evidence, and source attribution. A proposed rationale stays an inference or an open question. Explicit confirmation during the interview is recorded separately. Persistence is a backend operation and can be retried without duplicating findings.

- On first import, inventory the tree and analyze supported first-party code and relevant tests, documentation, configuration, and migrations module by module. Follow cross-module references and record evidence, coverage, and unknowns. The scan output identifies the repository and commit, snapshot location, file paths and hashes, languages, symbols, relationships, source ranges, and parser coverage or failures. Store the underlying files independently of any generated summary.
- For a later review, the maintainer chooses when to reassess. Compare the last reviewed commit with the chosen current commit, even when many intermediate commits exist. Keep both complete snapshots readable. Use changed files, symbol and relationship changes, affected callers, and decision-scope links to prioritize reading. Widen to a full analysis when a major refactor makes incremental matching unreliable. Retain confirmed rationale, flag questionable applicability for review, and advance the reviewed baseline only according to the review’s actual coverage.

## Still open

- Supported languages, repository size limits, and subsystem selection.
- Demo repository and presentation sequence. The clearest outcome discussed is one maintainer teaching the system something that a second developer can use.
- Remaining stack, deployment, LLM and speech recognition configuration, credentials and access, API and event contracts, and detailed low-level data model.
- Consolidated blueprint with the final user journey, error handling, scope, and acceptance criteria, followed by explicit build approval.

