"""Authorize this repository's GitHub Actions workflow to update the Cloud Run deployment."""

import argparse
import re
import shutil
import subprocess

from deploy.google_cloud import JOB, SERVICE


REPOSITORY_ID = "1464464780"  # Sayyam2911/CodeLineage
OWNER_ID = "109847905"
POOL = "codelineage-github"
PROVIDER = "github"


def configure(project: str, region: str) -> None:
    executable = shutil.which("gcloud")
    if not executable:
        raise ValueError("Install and sign in to the Google Cloud CLI before configuring CI/CD.")
    command = [executable, f"--project={project}", "--quiet"]
    regional = f"--region={region}"

    def cloud(*args, capture=False):
        result = subprocess.run([*command, *args], check=True, text=True, encoding="utf-8",
                                stdout=subprocess.PIPE if capture else None)
        return result.stdout.strip() if capture else None

    def exists(*args):
        return subprocess.run([*command, *args], capture_output=True).returncode == 0

    def grant(resource, member, role, *flags):
        cloud(*resource, *flags, f"--member={member}", f"--role=roles/{role}", "--format=none")

    number = cloud("projects", "describe", project, "--format=value(projectNumber)", capture=True)
    if not number.isascii() or not number.isdecimal():
        raise ValueError("Google Cloud did not return a project number.")
    api_identity = cloud("run", "services", "describe", SERVICE, regional,
                         "--format=value(spec.template.spec.serviceAccountName)", capture=True)
    scan_identity = cloud("run", "jobs", "describe", JOB, regional,
                          "--format=value(spec.template.spec.template.spec.serviceAccountName)", capture=True)
    cloud("artifacts", "repositories", "describe", SERVICE, f"--location={region}", "--format=none")
    cloud("services", "enable", "iam.googleapis.com", "cloudresourcemanager.googleapis.com",
          "iamcredentials.googleapis.com", "sts.googleapis.com")

    account = f"{SERVICE}-ci@{project}.iam.gserviceaccount.com"
    member = f"serviceAccount:{account}"
    if not exists("iam", "service-accounts", "describe", account):
        cloud("iam", "service-accounts", "create", f"{SERVICE}-ci", "--display-name=CodeLineage GitHub deployment")
    pools = ("iam", "workload-identity-pools")
    if not exists(*pools, "describe", POOL, "--location=global"):
        cloud(*pools, "create", POOL, "--location=global", "--display-name=CodeLineage GitHub Actions")
    provider_flags = ("--location=global", f"--workload-identity-pool={POOL}")
    condition = (
        f"assertion.repository_id == '{REPOSITORY_ID}' && assertion.repository_owner_id == '{OWNER_ID}' && "
        "assertion.ref == 'refs/heads/main' && assertion.event_name in ['push', 'workflow_dispatch'] && "
        "assertion.workflow_ref.endsWith('/.github/workflows/deploy-cloud-run.yml@refs/heads/main')"
    )
    operation = "update-oidc" if exists(*pools, "providers", "describe", PROVIDER, *provider_flags) else "create-oidc"
    cloud(*pools, "providers", operation, PROVIDER, *provider_flags, "--display-name=GitHub Actions",
          "--issuer-uri=https://token.actions.githubusercontent.com",
          "--attribute-mapping=google.subject=assertion.sub,attribute.repository_id=assertion.repository_id",
          f"--attribute-condition={condition}")
    principal = (f"principalSet://iam.googleapis.com/projects/{number}/locations/global/workloadIdentityPools/"
                 f"{POOL}/attribute.repository_id/{REPOSITORY_ID}")
    grant(("iam", "service-accounts", "add-iam-policy-binding", account), principal, "iam.workloadIdentityUser")
    grant(("artifacts", "repositories", "add-iam-policy-binding", SERVICE), member, "artifactregistry.writer",
          f"--location={region}")
    grant(("run", "services", "add-iam-policy-binding", SERVICE), member, "run.developer", regional)
    grant(("run", "jobs", "add-iam-policy-binding", JOB), member, "run.developer", regional)
    default_identity = f"{number}-compute@developer.gserviceaccount.com"
    for identity in sorted({api_identity or default_identity, scan_identity or default_identity}):
        grant(("iam", "service-accounts", "add-iam-policy-binding", identity), member, "iam.serviceAccountUser")

    print("Set these GitHub Actions repository variables for Sayyam2911/CodeLineage.")
    print(f"GCP_PROJECT_ID={project}\nGCP_PROJECT_NUMBER={number}\nGCP_REGION={region}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True)
    parser.add_argument("--region", default="us-central1")
    args = parser.parse_args()
    if not re.fullmatch(r"[a-z][a-z0-9-]{4,28}[a-z0-9]", args.project):
        parser.error("Use the Google Cloud project ID.")
    if not re.fullmatch(r"[a-z][a-z0-9-]{1,28}[0-9]", args.region):
        parser.error("Use a Google Cloud region such as us-central1.")
    try:
        configure(args.project, args.region)
    except (OSError, ValueError, subprocess.CalledProcessError) as exc:
        parser.exit(1, f"{exc}\n")
