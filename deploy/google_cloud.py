"""Build and deploy CodeLineage to a billing-enabled Google Cloud project."""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit
from uuid import uuid4


ROOT = Path(__file__).resolve().parents[1]
SERVICE = "codelineage"
JOB = "codelineage-scan"
QUEUE = "codelineage-analysis"
REQUIRED_SETTINGS = ("NEO4J_URI", "NEO4J_USER", "NEO4J_DATABASE", "AGORA_APP_ID", "AGORA_PIPELINE_ID")
OPTIONAL_SETTINGS = ("CODELINEAGE_ANALYSIS_PROVIDER", "CODELINEAGE_ANALYSIS_MODEL", "CODELINEAGE_ANALYSIS_BATCHES")
REQUIRED_SECRETS = {"NEO4J_PASSWORD": "codelineage-neo4j-password", "AGORA_APP_CERTIFICATE": "codelineage-agora-certificate"}
OPTIONAL_SECRETS = {"CODELINEAGE_ANALYSIS_KEY": "codelineage-analysis-key"}


def load_settings(path: Path) -> tuple[dict[str, str], dict[str, str]]:
    settings = {}
    keys = {*REQUIRED_SETTINGS, *OPTIONAL_SETTINGS, *REQUIRED_SECRETS, *OPTIONAL_SECRETS}
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        if match := re.fullmatch(r"\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*", line):
            key, value = match.groups()
            if key in keys:
                settings[key] = value[1:-1] if len(value) >= 2 and value[0] in "\"'" and value[-1] == value[0] else value
    missing = [key for key in (*REQUIRED_SETTINGS, *REQUIRED_SECRETS) if not settings.get(key)]
    if missing:
        raise ValueError("Set these deployment values in your env file: " + ", ".join(missing))
    public = {key: settings[key] for key in (*REQUIRED_SETTINGS, *OPTIONAL_SETTINGS) if settings.get(key)}
    for key, value in public.items():
        if not re.fullmatch(r"[A-Za-z0-9_.:/+@-]+", value):
            raise ValueError(f"{key} contains unsupported characters for a Cloud Run setting.")
    uri = urlsplit(public["NEO4J_URI"])
    if uri.scheme != "neo4j+s" or not uri.hostname or uri.username or uri.password or uri.path not in ("", "/"):
        raise ValueError("Use your Aura neo4j+s:// connection URI without embedded credentials.")
    if public.get("CODELINEAGE_ANALYSIS_PROVIDER", "openai") not in {"meta", "openai"}:
        raise ValueError("CODELINEAGE_ANALYSIS_PROVIDER must be meta or openai.")
    if "CODELINEAGE_ANALYSIS_BATCHES" in public and not public["CODELINEAGE_ANALYSIS_BATCHES"].isdecimal():
        raise ValueError("CODELINEAGE_ANALYSIS_BATCHES must be a whole number.")
    secrets = {key: settings[key] for key in (*REQUIRED_SECRETS, *OPTIONAL_SECRETS) if settings.get(key)}
    return public, secrets


def deploy(project: str, region: str, settings: dict, secrets: dict, rotate: bool) -> None:
    executable = shutil.which("gcloud")
    if not executable:
        raise ValueError("Install the Google Cloud CLI or run this command in Google Cloud Shell.")
    command = [executable, f"--project={project}", "--quiet"]
    cli_env = os.environ | {"CLOUDSDK_CORE_LOG_HTTP": "false"}
    regional = f"--region={region}"
    zonal_queue = f"--location={region}"

    def cloud(*args, capture=False, secret=None):
        result = subprocess.run([*command, *args], cwd=ROOT, env=cli_env, check=True,
                                stdout=subprocess.PIPE if capture else None,
                                input=secret.encode("utf-8") if secret is not None else None)
        return result.stdout.decode("utf-8").strip() if capture else None

    def ensure(describe, create):
        result = subprocess.run([*command, *describe], cwd=ROOT, env=cli_env, capture_output=True)
        if result.returncode:
            cloud(*create)

    def grant(resource, account, role, *flags):
        cloud(*resource, *flags, f"--member=serviceAccount:{account}", f"--role=roles/{role}", "--format=none")

    number = cloud("projects", "describe", project, "--format=value(projectNumber)", capture=True)
    if not number.isascii() or not number.isdecimal():
        raise ValueError("Google Cloud did not return a project number.")
    service_url = f"https://{SERVICE}-{number}.{region}.run.app"
    snapshot_bucket = f"cl-{number}-{region}-snapshots"
    source_bucket = f"cl-{number}-{region}-builds"
    service_account = f"{SERVICE}-api@{project}.iam.gserviceaccount.com"
    scan_account = f"{SERVICE}-scan@{project}.iam.gserviceaccount.com"
    task_account = f"{SERVICE}-tasks@{project}.iam.gserviceaccount.com"
    build_account = f"{SERVICE}-build@{project}.iam.gserviceaccount.com"

    print(f"Preparing Cloud Run, Cloud Build and shared storage in {project}, {region}.", flush=True)
    cloud("services", "enable", "run.googleapis.com", "cloudbuild.googleapis.com", "artifactregistry.googleapis.com",
          "cloudtasks.googleapis.com", "secretmanager.googleapis.com", "storage.googleapis.com", "iam.googleapis.com",
          "logging.googleapis.com")
    for account in (service_account, scan_account, task_account, build_account):
        name = account.split("@", 1)[0]
        ensure(("iam", "service-accounts", "describe", account),
               ("iam", "service-accounts", "create", name))
    for bucket in (snapshot_bucket, source_bucket):
        address = f"gs://{bucket}"
        ensure(("storage", "buckets", "describe", address),
               ("storage", "buckets", "create", address, f"--location={region}",
                "--uniform-bucket-level-access", "--public-access-prevention"))
    ensure(("artifacts", "repositories", "describe", SERVICE, f"--location={region}"),
           ("artifacts", "repositories", "create", SERVICE, f"--location={region}", "--repository-format=docker"))
    ensure(("tasks", "queues", "describe", QUEUE, zonal_queue),
           ("tasks", "queues", "create", QUEUE, zonal_queue, "--max-concurrent-dispatches=4",
            "--max-attempts=8", "--min-backoff=5s", "--max-backoff=120s"))

    snapshot_iam = ("storage", "buckets", "add-iam-policy-binding", f"gs://{snapshot_bucket}")
    grant(snapshot_iam, service_account, "storage.objectViewer")
    grant(snapshot_iam, scan_account, "storage.objectViewer")
    grant(snapshot_iam, scan_account, "storage.objectCreator")
    grant(("storage", "buckets", "add-iam-policy-binding", f"gs://{source_bucket}"), build_account, "storage.objectViewer")
    grant(("artifacts", "repositories", "add-iam-policy-binding", SERVICE), build_account,
          "artifactregistry.writer", f"--location={region}")
    grant(("projects", "add-iam-policy-binding", project), build_account, "logging.logWriter", "--condition=None")
    task_iam = ("iam", "service-accounts", "add-iam-policy-binding", task_account)
    for account in (service_account, scan_account):
        grant(("tasks", "queues", "add-iam-policy-binding", QUEUE), account, "cloudtasks.enqueuer", zonal_queue)
        grant(task_iam, account, "iam.serviceAccountUser")
    grant(task_iam, f"service-{number}@gcp-sa-cloudtasks.iam.gserviceaccount.com", "iam.serviceAccountUser")

    bindings = {}
    secret_names = REQUIRED_SECRETS | OPTIONAL_SECRETS
    for key, value in secrets.items():
        name = secret_names[key]
        ensure(("secrets", "describe", name), ("secrets", "create", name, "--replication-policy=automatic"))
        version = cloud("secrets", "versions", "list", name, "--filter=state=ENABLED", "--sort-by=~createTime",
                        "--limit=1", "--format=value(name)", capture=True)
        if not version or rotate:
            version = cloud("secrets", "versions", "add", name, "--data-file=-", "--format=value(name)",
                            capture=True, secret=value)
        version = version.rsplit("/", 1)[-1]
        if not version.isascii() or not version.isdecimal():
            raise ValueError(f"Secret Manager did not return a version for {name}.")
        grant(("secrets", "add-iam-policy-binding", name), service_account, "secretmanager.secretAccessor")
        bindings[key] = f"{name}:{version}"

    image_name = f"{region}-docker.pkg.dev/{project}/{SERVICE}/{SERVICE}"
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    image_tag = f"{image_name}:{timestamp}-{uuid4().hex[:8]}"
    build_id = cloud("builds", "submit", ".", regional, "--config=cloudbuild.yaml", "--async", "--format=value(id)",
                     f"--service-account=projects/{project}/serviceAccounts/{build_account}",
                     f"--gcs-source-staging-dir=gs://{source_bucket}/source", f"--substitutions=_IMAGE={image_tag}", capture=True)
    print(f"Cloud Build {build_id} is building and testing the container.", flush=True)
    deadline = time.monotonic() + 1500
    while time.monotonic() < deadline:
        build = json.loads(cloud("builds", "describe", build_id, regional, "--format=json(status,results)", capture=True))
        if build["status"] not in {"PENDING", "QUEUED", "WORKING"}:
            break
        time.sleep(8)
    else:
        raise ValueError(f"Timed out waiting for Cloud Build {build_id}.")
    if build["status"] != "SUCCESS":
        raise ValueError(f"Cloud Build {build_id} ended with {build['status']}. Check its logs in Cloud Build.")
    digest = next((result["digest"] for result in build["results"]["images"] if result["name"] == image_tag), "")
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", digest):
        raise ValueError(f"Cloud Build {build_id} did not return the image digest.")
    image = f"{image_name}@{digest}"

    shared = {
        "CODELINEAGE_SNAPSHOT_BUCKET": snapshot_bucket,
        "CODELINEAGE_TASK_QUEUE": f"projects/{project}/locations/{region}/queues/{QUEUE}",
        "CODELINEAGE_TASK_SERVICE": service_url,
        "CODELINEAGE_TASK_IDENTITY": task_account,
    }
    def encode(fields):
        return ",".join(f"{name}={value}" for name, value in fields.items())

    cloud("run", "jobs", "deploy", JOB, regional, f"--image={image}", f"--service-account={scan_account}",
          "--command=python", "--args=-m,codelineage.worker", "--tasks=1", "--max-retries=1", "--task-timeout=1200s",
          "--cpu=2", "--memory=4Gi", "--set-env-vars=" + encode(shared))
    grant(("run", "jobs", "add-iam-policy-binding", JOB), service_account, "run.jobsExecutorWithOverrides", regional)

    api_settings = settings | shared | {
        "CODELINEAGE_PUBLIC_URL": service_url,
        "CODELINEAGE_SCAN_JOB": f"projects/{project}/locations/{region}/jobs/{JOB}",
    }
    cloud("run", "deploy", SERVICE, regional, f"--image={image}", f"--service-account={service_account}",
          "--ingress=all", "--no-invoker-iam-check", "--port=8080", "--timeout=300s", "--cpu=1", "--memory=2Gi",
          "--concurrency=12", "--min=0", "--max=3", "--no-cpu-throttling",
          "--startup-probe=httpGet.path=/health,httpGet.port=8080,periodSeconds=5,timeoutSeconds=3,failureThreshold=24",
          "--set-env-vars=" + encode(api_settings), "--set-secrets=" + encode(bindings))
    subprocess.run([sys.executable, str(ROOT / "deploy" / "smoke.py"), service_url, "--voice"], cwd=ROOT, check=True)
    print(f"CodeLineage is available at {service_url}", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", help="Google Cloud project ID")
    parser.add_argument("--region", default="us-central1")
    parser.add_argument("--env-file", type=Path, default=ROOT / ".env")
    parser.add_argument("--check", action="store_true", help="Validate the env file locally")
    parser.add_argument("--rotate-secrets", action="store_true", help="Publish new versions from the env file")
    args = parser.parse_args()
    try:
        settings, secrets = load_settings(args.env_file)
        if args.check:
            print("Deployment settings are present for Aura and Agora Studio.")
            print("Secret Manager bindings: " + ", ".join(secrets))
            return
        if not re.fullmatch(r"[a-z][a-z0-9-]{4,28}[a-z0-9]", args.project or ""):
            raise ValueError("Provide a Google Cloud project ID with --project.")
        if not re.fullmatch(r"[a-z][a-z0-9-]{1,28}[0-9]", args.region):
            raise ValueError("Provide a Google Cloud region such as us-central1.")
        deploy(args.project, args.region, settings, secrets, args.rotate_secrets)
    except (OSError, ValueError, subprocess.CalledProcessError) as exc:
        parser.exit(1, f"{exc}\n")


if __name__ == "__main__":
    main()
