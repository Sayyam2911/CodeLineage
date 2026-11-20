"""Roll out a tested image to the existing Cloud Run API and scan job."""

import argparse
import json
import re
import subprocess
import sys

from deploy.google_cloud import JOB, SERVICE
from deploy.smoke import check_service


def rollout(project: str, region: str, image: str, suffix: str) -> None:
    repository = f"{region}-docker.pkg.dev/{project}/{SERVICE}/{SERVICE}"
    if not re.fullmatch(re.escape(repository) + r"@sha256:[a-f0-9]{64}", image):
        raise ValueError("Use an image digest in the CodeLineage Artifact Registry repository.")
    if not re.fullmatch(r"ci-[0-9]+-[0-9]+", suffix) or len(SERVICE) + 1 + len(suffix) > 63:
        raise ValueError("Use a revision suffix in the form ci-RUN_ID-RUN_ATTEMPT.")
    revision = f"{SERVICE}-{suffix}"
    flags = (f"--project={project}", f"--region={region}", "--quiet")

    def cloud(*args, capture=False):
        result = subprocess.run(["gcloud", "run", *args, *flags], check=True, text=True, encoding="utf-8",
                                stdout=subprocess.PIPE if capture else None)
        return result.stdout.strip() if capture else None

    def set_traffic(percentages):
        assignments = ",".join(f"{name}={percent}" for name, percent in percentages.items())
        cloud("services", "update-traffic", SERVICE, f"--to-revisions={assignments}")

    status = json.loads(cloud("services", "describe", SERVICE, "--format=json(status)", capture=True))["status"]
    previous_traffic = {}
    for target in status.get("traffic", []):
        if percent := target.get("percent", 0):
            name = target["revisionName"]
            previous_traffic[name] = previous_traffic.get(name, 0) + percent
    url = status.get("url", "")
    previous_image = cloud("jobs", "describe", JOB, "--format=value(spec.template.spec.template.spec.containers[0].image)",
                           capture=True)
    if sum(previous_traffic.values()) != 100 or not url.startswith("https://") or not previous_image:
        raise ValueError("Rollout requires a serving API revision and an existing scan job image.")

    cloud("services", "update", SERVICE, f"--image={image}", f"--revision-suffix={suffix}", "--no-traffic",
          "--deploy-health-check")
    ready = cloud("services", "describe", SERVICE, "--format=value(status.latestReadyRevisionName)", capture=True)
    if ready != revision:
        raise ValueError(f"The candidate revision {revision} did not become ready.")

    traffic_attempted = False
    try:
        cloud("jobs", "update", JOB, f"--image={image}")
        traffic_attempted = True
        set_traffic({revision: 100})
        check_service(url, voice=True)
    except (OSError, ValueError, subprocess.CalledProcessError):
        print("Rollout failed. Restoring the previous Cloud Run deployment.", file=sys.stderr, flush=True)
        try:
            if traffic_attempted:
                set_traffic(previous_traffic)
            cloud("jobs", "update", JOB, f"--image={previous_image}")
        except (OSError, subprocess.CalledProcessError) as error:
            print(f"Cloud Run rollback failed. {error}", file=sys.stderr, flush=True)
        raise
    print(f"Serving {revision} at {url}", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True)
    parser.add_argument("--region", required=True)
    parser.add_argument("--image", required=True)
    parser.add_argument("--revision-suffix", required=True)
    args = parser.parse_args()
    try:
        rollout(args.project, args.region, args.image, args.revision_suffix)
    except (OSError, ValueError, subprocess.CalledProcessError) as exc:
        parser.exit(1, f"{exc}\n")
