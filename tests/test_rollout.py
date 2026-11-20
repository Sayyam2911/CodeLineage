import json
import time
from subprocess import CalledProcessError, CompletedProcess
from types import SimpleNamespace

import pytest

from deploy import rollout


@pytest.mark.parametrize("failure", [None, "startup", "readiness", "job", "smoke"])
def test_rollout_preserves_the_serving_release_on_failure(monkeypatch, failure):
    repository = "us-central1-docker.pkg.dev/example-project/codelineage/codelineage"
    previous_image = repository + "@sha256:" + "a" * 64
    next_image = repository + "@sha256:" + "b" * 64
    url = "https://codelineage-123.us-central1.run.app"
    revision = "codelineage-ci-12-1"
    changes = []
    states = iter(["Unknown", "True"] if failure is None else ["False" if failure == "readiness" else "True"])

    def cloud(command, **kwargs):
        resource, action, name = command[2:5]
        arguments = command[5:]
        output = ""
        if action == "describe":
            if resource == "jobs":
                output = previous_image
            elif resource == "revisions":
                assert name == revision and "--format=json(status)" in arguments
                output = json.dumps({"status": {"conditions": [{"type": "Ready", "status": next(states)}]}})
            else:
                assert resource == "services" and "--format=json(status)" in arguments
                output = json.dumps({"status": {"url": url, "traffic": [
                    {"revisionName": "codelineage-old", "percent": 90},
                    {"revisionName": "codelineage-prev", "percent": 10},
                ]}})
        elif action == "update" and resource == "services":
            assert name == "codelineage" and {"--no-traffic", "--deploy-health-check"} <= set(arguments)
            changes.append(("stage", arguments[0]))
            if failure == "startup":
                raise CalledProcessError(1, command)
        else:
            changes.append((resource, arguments[0]))
            if failure == "job" and resource == "jobs" and arguments[0] == "--image=" + next_image:
                raise CalledProcessError(1, command)
        return CompletedProcess(command, 0, stdout=output)

    def smoke(actual_url, *, voice):
        assert actual_url == url and voice
        changes.append(("smoke", url))
        if failure == "smoke":
            raise ValueError("The hosted smoke test failed.")

    monkeypatch.setattr(rollout.subprocess, "run", cloud)
    monkeypatch.setattr(rollout, "check_service", smoke)
    waits = []
    monkeypatch.setattr(rollout, "time", SimpleNamespace(monotonic=time.monotonic, sleep=waits.append))
    deploy = ("example-project", "us-central1", next_image, "ci-12-1")
    if failure:
        with pytest.raises(ValueError if failure in {"readiness", "smoke"} else CalledProcessError):
            rollout.rollout(*deploy)
    else:
        rollout.rollout(*deploy)

    expected = [("stage", "--image=" + next_image)]
    if failure not in {"startup", "readiness"}:
        expected.append(("jobs", "--image=" + next_image))
        if failure != "job":
            expected.extend([("services", f"--to-revisions={revision}=100"), ("smoke", url)])
        if failure == "smoke":
            expected.append(("services", "--to-revisions=codelineage-old=90,codelineage-prev=10"))
        if failure:
            expected.append(("jobs", "--image=" + previous_image))
    assert changes == expected
    assert waits == ([2] if failure is None else [])
