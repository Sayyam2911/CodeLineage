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

With voice configured, choose **Start a voice review**, then **Use the Healthchecks demo** and **Open review**. With the ref left empty, the demo resolves to Healthchecks v5.0.3. The interviewer reads the first question, shows the pinned alert ordering code, and pauses. Select **Answer question** and allow microphone access, then select **Finish answer** when you’re done. Review the proposed summary on screen, record a correction if needed, or select **Confirm and save**. **Next question** opens and reads the next prompt. Choose **Explore reviewed code** to ask why new webhook channels wait, or ask to see the corresponding source.

~~~sh
uv run --locked pytest
npm --prefix web run build
~~~

Set `CODELINEAGE_TEST_NEO4J_URI` for the Neo4j integration test. Set `CODELINEAGE_TEST_NEO4J_USER` and `CODELINEAGE_TEST_NEO4J_PASSWORD` to its credentials, and `CODELINEAGE_TEST_NEO4J_DATABASE` if its database name differs from `neo4j`. An empty username selects an unauthenticated test instance. The test uses a uniquely named synthetic repository and removes its records afterward.

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

The browser opens the microphone when the participant chooses to speak and releases it when the participant finishes or the interviewer replies. The server issues expiring RTC tokens and separate, session-bound tool credentials. Agora can open source evidence and propose an interview change using the participant's live answer. The browser displays the exact summary for explicit approval and the agent checks the saved receipt.

Use **Play question** to resume audio after a reload and **Repeat question** to hear the current prompt again. Select **End audio** to disconnect. [Agora Studio connection guide](https://docs.agora.io/en/ai/studio/deploy/connect-agent) · [Agora Python quickstart](https://github.com/AgoraIO-Conversational-AI/agent-quickstart-python/tree/bd1af724bed885c39a5a57235b37ec3bb3fd6396)

## Managed deployment

Use Python 3.10+, an authenticated Google Cloud CLI, and a billing-enabled project where you can enable APIs, create resources, and grant IAM roles. Put your Aura and Agora Studio settings in the gitignored `.env` using the names in `.env.example`. Set `CODELINEAGE_ANALYSIS_KEY` to enable model-based review.

~~~sh
python deploy/google_cloud.py --check
python deploy/google_cloud.py --project YOUR_PROJECT_ID --region us-central1
~~~

The command builds and tests a Linux image in Cloud Build and deploys its digest to both the public Cloud Run service and the scan job. It configures Artifact Registry, private build and snapshot buckets, the analysis queue, and separate service accounts. The API gets its credentials from numbered Secret Manager versions and uses its Cloud Run HTTPS URL for Agora callbacks. The API independently verifies the Google-issued OIDC token on each analysis task. The command reuses provisioned resources on later runs. Pass `--env-file PATH` for a different env file or `--rotate-secrets` to publish new credential versions. [Cloud Run container contract](https://docs.cloud.google.com/run/docs/container-contract) · [Cloud Tasks authentication](https://docs.cloud.google.com/tasks/docs/creating-http-target-tasks)

The deployment prints the service URL after checking the homepage, health endpoint, task authentication, and voice configuration. Run the Healthchecks smoke test against that URL to verify the scan job, Cloud Storage artifacts, Aura-backed diagram, and source lines. A snapshot captured locally gets its Cloud Storage copy on the first hosted scan.

~~~sh
python deploy/smoke.py https://YOUR_SERVICE_URL --voice --scan
~~~

To exercise the hosted voice flow, open the service URL, confirm an answer in **Start a voice review**, and ask for its rationale in a fresh **Explore reviewed code** session. To build the image locally, run `docker build -t codelineage:local .`. On a development network with a proxy CA, pass `--secret id=proxy_ca,src=/etc/ssl/certs/ca-certificates.crt` to Docker so the package installs can verify TLS.

The scan job uploads immutable artifacts and writes the completion manifest last. The backend checks the manifest and archive checksum before reading source. Cloud Tasks resume analysis in bounded steps tied to a scan attempt, and rerunning a step reuses its checkpoint. Confirmation commits the claim, its evidence, the receipt and the event in a single Neo4j transaction.

With Neo4j configured, each completed scan publishes a commit-pinned graph of files, components, extracted and inferred relationships, and review findings. Opening an existing snapshot publishes its graph if needed. The diagram and interview context use this topology, and source excerpts are read from the pinned snapshot artifacts. Start a Cypher graph view at a repository to see the connected data.

~~~cypher
MATCH p=(r:CodeRepository {name: 'healthchecks/healthchecks'})
  -[:HAS_SNAPSHOT]->(:CodeSnapshot)-[:HAS_FILE]->(f:SourceFile {path: 'hc/api/models.py'})
  -[:DEFINES]->(:CodeComponent)-[:CODE_RELATION]->(:CodeComponent)
RETURN p LIMIT 25
~~~
