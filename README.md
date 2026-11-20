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

Open `http://localhost:8000` in a browser. FastAPI serves the static export from the Next.js App Router. For development with live reload, keep the backend running and start `npm --prefix web run dev` in a second terminal. Open `http://localhost:3000`. The Next.js development server forwards API requests and the event stream to FastAPI. Set `CODELINEAGE_API_ORIGIN` for a different backend origin or `CODELINEAGE_DATA` for a different database and snapshot directory.

Choose **Create or update code lineage**, then **Use the Healthchecks demo** and **Open review**. With the ref left empty, the demo resolves to Healthchecks v5.0.3. The first question focuses alert delivery and shows the pinned ordering code. Type a reason, inspect the proposed summary, interrupt or correct it, and approve it explicitly. In a fresh **Understand code lineage** session, ask why new webhook channels wait. The answer separates the participant's rationale from the source excerpt. A line can still be opened for a file Graphify could not parse.

~~~sh
uv run --locked pytest
npm --prefix web run build
~~~

Set `CODELINEAGE_TEST_NEO4J_URI` for the Neo4j integration test. For a disposable local database, also set `CODELINEAGE_TEST_NEO4J_USER` and `CODELINEAGE_TEST_NEO4J_PASSWORD` to its configured credentials. An empty username selects an unauthenticated test instance.

## Semantic analysis and voice

Local development defaults to structural interview topics. Copy [`.env.example`](.env.example) to `.env` for semantic analysis and voice, then start the service with the environment file.

~~~sh
uv run --locked --env-file .env uvicorn codelineage.main:app --host 127.0.0.1 --port 8000
~~~

Set `CODELINEAGE_ANALYSIS_PROVIDER=meta` and put your Meta Model API key in `CODELINEAGE_ANALYSIS_KEY`. CodeLineage sends public source excerpts to the Responses API using `muse-spark-1.3-contributor`. Meta may use Contributor inputs for model training. Use public demo source without sensitive or personal data. For OpenAI, set the provider to `openai` and supply its key. You can override either default model with `CODELINEAGE_ANALYSIS_MODEL`. The default analysis budget is 40 batches. Results report partial coverage at the budget limit, and inference citations must match the pinned source. [Meta Model API](https://dev.meta.ai/docs/muse-spark)

In Agora AI Studio, publish an agent with Murf Falcon selected as text-to-speech. Copy its Pipeline ID and use the App ID and App Certificate from the same project. Keep the certificate and API keys on the server. The browser can use localhost for microphone access. Agora needs a reachable HTTPS endpoint for `POST /voice/tools/...`.

| Variable | Purpose |
| --- | --- |
| `AGORA_APP_ID`, `AGORA_APP_CERTIFICATE` | Agora project with Conversational AI enabled and token signing |
| `AGORA_PIPELINE_ID` | Published Studio pipeline with Murf Falcon. CodeLineage adds its interview instructions and tools to each session. |
| `CODELINEAGE_PUBLIC_URL` | HTTPS base URL that Agora can call for tools |
| `MURF_API_KEY`, `MURF_VOICE_ID` | Used for direct provider configuration when `AGORA_PIPELINE_ID` is empty |
| `MURF_MODEL`, `DEEPGRAM_API_KEY` | Optional direct provider settings. The Murf model defaults to `FALCON`. |
| `CODELINEAGE_VOICE_MODEL`, `CODELINEAGE_VOICE_MODEL_KEY` | Optional direct OpenAI voice-turn settings. The default is Agora-managed `gpt-4o-mini`. |

The browser publishes microphone audio to Agora. The server issues expiring RTC tokens and separate, session-bound tool credentials. Agora can open evidence and propose an interview change using a participant utterance from the provider history. The browser displays the exact summary for explicit approval. Spoken approval remains pending verification of provider delivery and assent. The voice agent checks the stored receipt before saying an edit was saved. Use the typed flow if voice is unavailable.

In a review or lineage session, select **Start voice** and allow microphone access. Ask why Healthchecks orders delivery and follow up by asking to see the source. Select **End voice** when you finish. [Agora Studio connection guide](https://docs.agora.io/en/ai/studio/deploy/connect-agent) · [Agora Python quickstart](https://github.com/AgoraIO-Conversational-AI/agent-quickstart-python/tree/bd1af724bed885c39a5a57235b37ec3bb3fd6396)

## Managed deployment

Use the same container image for the Cloud Run service and scan job. The web bundle is served by FastAPI in the service image. A local image build is `docker build -t codelineage:local .`. In a managed development network with a proxy CA, pass `--secret id=proxy_ca,src=/etc/ssl/certs/ca-certificates.crt` to the build so package installs retain TLS verification.

1. Create a private Cloud Storage bucket, a Cloud Tasks queue, a Neo4j database, and separate Cloud Run service and job service accounts.
2. Build and publish the image to Artifact Registry. Deploy the Cloud Run service with its service identity and the shared settings below. Bind secret values through Secret Manager. Use the HTTPS service URL for `CODELINEAGE_TASK_SERVICE` and `CODELINEAGE_PUBLIC_URL`.
3. Deploy a Cloud Run Job using the same image and the scan-job identity. Allow at least 20 minutes and memory for the capped 250 MiB source capture and Graphify. The service overrides the job arguments with `-m codelineage.worker OWNER/REPO COMMIT SCOPE ATTEMPT`.
4. Grant the API service identity permission to run the job with overrides, read the bucket, and enqueue Cloud Tasks. Grant the scan job identity permission to create and read bucket objects and enqueue tasks. The enqueuing identities need permission to use the task OIDC identity. Configure the task service identity as an authorized invoker for Cloud Run when service authentication applies. The backend independently validates Google OIDC tokens for the internal analysis route.
5. Configure `CODELINEAGE_SCAN_JOB` on the service after the job exists, then smoke-test the Healthchecks import and read-only retrieval. Live voice tools require public HTTPS reachability for the scoped tool endpoints.

| Setting | Service | Scan job |
| --- | --- | --- |
| `CODELINEAGE_SNAPSHOT_BUCKET` | Private bucket name | Same bucket name |
| `CODELINEAGE_TASK_QUEUE` | `projects/PROJECT/locations/REGION/queues/QUEUE` | Same queue |
| `CODELINEAGE_TASK_SERVICE` | HTTPS service base URL and task OIDC audience | Same URL |
| `CODELINEAGE_TASK_IDENTITY` | Task service account email | Same email |
| `CODELINEAGE_SCAN_JOB` | `projects/PROJECT/locations/REGION/jobs/JOB` | Omit |
| `NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD` | Managed Neo4j credentials | Omit |
| `CODELINEAGE_ANALYSIS_KEY` and voice settings | Provider secrets and configuration | Omit |

The scan job uploads immutable artifacts and writes the completion manifest last. The backend checks the manifest and archive checksum before reading source. Cloud Tasks resume analysis in bounded steps tied to a scan attempt, and rerunning a step reuses its checkpoint. Confirmation commits the claim, its evidence, the receipt and the event in a single Neo4j transaction.
