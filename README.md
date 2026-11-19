# CodeLineage

CodeLineage records the reasons behind architecture decisions. Start with a public GitHub URL, review a commit-pinned diagram and its evidence, and confirm the scope of an explanation. A fresh session can then retrieve the reviewed explanation and its evidence.

- [Build plan and acceptance](MILESTONES.md)
- [Architecture and product decisions](Agora-Design-Decisions.md)

## Run locally

Use Git, Python 3.12+, uv, and Node.js 22+.

~~~sh
uv sync --locked
npm --prefix web ci
npm --prefix web run build
uv run --locked uvicorn codelineage.main:app --host 127.0.0.1 --port 8000
~~~

Open the service in a browser. For development with live reload, run the backend on port 8000 and run \`npm --prefix web run dev\` in a second terminal. Vite proxies the API and event stream to FastAPI. \`CODELINEAGE_DATA\` changes the default \`.data\` directory for the local database and snapshots.

Choose **Create or update code lineage**, then **Use the Healthchecks demo**. With the ref left empty, the demo resolves to Healthchecks v5.0.3. The first question focuses alert delivery and shows the pinned ordering code. Type a reason, inspect the proposed summary, interrupt or correct it, and approve it explicitly. In a fresh **Understand code lineage** session, ask why new webhook channels wait. The answer separates the participant's rationale from the source excerpt. A line can still be opened for a file Graphify could not parse.

~~~sh
uv run --locked pytest
npm --prefix web run build
~~~

Set \`CODELINEAGE_TEST_NEO4J_URI\` for the Neo4j integration test. For a disposable local database, also set \`CODELINEAGE_TEST_NEO4J_USER\` and \`CODELINEAGE_TEST_NEO4J_PASSWORD\` to its configured credentials. An empty username selects an unauthenticated test instance.

## Semantic analysis and voice

Local development defaults to offline, structural interview topics. Set \`CODELINEAGE_ANALYSIS_KEY\` to enable the OpenAI analysis of public source excerpts. \`CODELINEAGE_ANALYSIS_MODEL\` defaults to \`gpt-4o-mini\`. \`CODELINEAGE_ANALYSIS_BATCHES\` defaults to 40 bounded requests. The scan reports partial semantic coverage when that budget is exhausted, and inference citations must match the pinned source.

To start a live voice session, configure the following on the server and make the service reachable at its HTTPS URL.

| Variable | Purpose |
| --- | --- |
| \`AGORA_APP_ID\`, \`AGORA_APP_CERTIFICATE\` | Agora project with Conversational AI enabled and token signing |
| \`MURF_API_KEY\`, \`MURF_VOICE_ID\` | Project-owned Murf key and Falcon-compatible voice |
| \`CODELINEAGE_PUBLIC_URL\` | HTTPS base URL that Agora can call for tools |
| \`MURF_MODEL\` | Optional model override, defaults to \`FALCON\` |
| \`DEEPGRAM_API_KEY\` | Optional key for bring-your-own Deepgram credentials |
| \`CODELINEAGE_VOICE_MODEL\`, \`CODELINEAGE_VOICE_MODEL_KEY\` | Optional OpenAI voice-turn model and provider key, otherwise Agora-managed \`gpt-4o-mini\` |

The browser publishes microphone audio to Agora. The server issues expiring RTC tokens and separate, session-bound tool credentials. Agora can open evidence and propose an interview change using a participant utterance from the provider history. The provider history doesn't establish delivery of the full read-back, so the browser displays the exact summary for explicit approval. The voice agent checks the stored receipt before saying an edit was saved. Use the typed flow if voice is unavailable.

Voice lifecycle and token usage follow the [official Agora Python quickstart](https://github.com/AgoraIO-Conversational-AI/agent-quickstart-python/tree/bd1af724bed885c39a5a57235b37ec3bb3fd6396). Live Agora, Murf and microphone acceptance requires a configured project and a real user session.

## Managed deployment

Use the same container image for the Cloud Run service and scan job. The web bundle is served by FastAPI in the service image. A local image build is \`docker build -t codelineage:local .\`. In a managed development network with a proxy CA, pass \`--secret id=proxy_ca,src=/etc/ssl/certs/ca-certificates.crt\` to the build so package installs retain TLS verification.

1. Create a private Cloud Storage bucket, a Cloud Tasks queue, a Neo4j database, and separate Cloud Run service and job service accounts.
2. Build and publish the image to Artifact Registry. Deploy the Cloud Run service with its service identity and the shared settings below. Bind secret values through Secret Manager. Use the HTTPS service URL for \`CODELINEAGE_TASK_SERVICE\` and \`CODELINEAGE_PUBLIC_URL\`.
3. Deploy a Cloud Run Job using the same image and the scan-job identity. Allow at least 20 minutes and memory for the capped 250 MiB source capture and Graphify. The service overrides the job arguments with \`-m codelineage.worker OWNER/REPO COMMIT SCOPE ATTEMPT\`.
4. Grant the API service identity permission to run the job with overrides, read the bucket, and enqueue Cloud Tasks. Grant the scan job identity permission to create and read bucket objects and enqueue tasks. The enqueuing identities need permission to use the task OIDC identity. Configure the task service identity as an authorized invoker for Cloud Run when service authentication applies. The backend independently validates Google OIDC tokens for the internal analysis route.
5. Configure \`CODELINEAGE_SCAN_JOB\` on the service after the job exists, then smoke-test the Healthchecks import and read-only retrieval. Live voice tools require public HTTPS reachability for the scoped tool endpoints.

| Setting | Service | Scan job |
| --- | --- | --- |
| \`CODELINEAGE_SNAPSHOT_BUCKET\` | Private bucket name | Same bucket name |
| \`CODELINEAGE_TASK_QUEUE\` | \`projects/PROJECT/locations/REGION/queues/QUEUE\` | Same queue |
| \`CODELINEAGE_TASK_SERVICE\` | HTTPS service base URL and task OIDC audience | Same URL |
| \`CODELINEAGE_TASK_IDENTITY\` | Task service account email | Same email |
| \`CODELINEAGE_SCAN_JOB\` | \`projects/PROJECT/locations/REGION/jobs/JOB\` | Omit |
| \`NEO4J_URI\`, \`NEO4J_USER\`, \`NEO4J_PASSWORD\` | Managed Neo4j credentials | Omit |
| \`CODELINEAGE_ANALYSIS_KEY\` and voice settings | Provider secrets and configuration | Omit |

The scan job uploads immutable artifacts and writes the completion manifest last. The backend checks the manifest and archive checksum before reading source. Cloud Tasks resume analysis in bounded steps tied to a scan attempt, and rerunning a step reuses its checkpoint. Confirmation commits the claim, its evidence, the receipt and the event in a single Neo4j transaction.
