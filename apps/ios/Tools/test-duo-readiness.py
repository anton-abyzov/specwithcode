#!/usr/bin/env python3
"""Exercise the prerequisite gate without installing SDKs or booting devices."""
import copy
import json
import os
from pathlib import Path
import subprocess
import tempfile

TYPE = "com.apple.CoreSimulator.SimDeviceType.iPhone-Duo"
RUNTIME = "com.apple.CoreSimulator.SimRuntime.iOS-27-1"
BASE = {
    "sdk": "27.1",
    "types": {"devicetypes": [{"name": "iPhone Duo", "identifier": TYPE}]},
    "runtimes": {"runtimes": [{"platform": "iOS", "version": "27.1", "isAvailable": True, "identifier": RUNTIME}]},
    "devices": {"devices": {}},
}
FAKE = '''#!/usr/bin/env python3
import json,os,sys
s=json.loads(os.environ["DUO_GATE_FIXTURE"])
a=sys.argv[1:]
if a==["--sdk","iphonesimulator","--show-sdk-version"]: print(s["sdk"])
elif a==["simctl","list","devicetypes","-j"]: print(json.dumps(s["types"]))
elif a==["simctl","list","runtimes","-j"]: print(json.dumps(s["runtimes"]))
elif a==["simctl","list","devices","-j"]: print(json.dumps(s["devices"]))
else: sys.exit("Unexpected xcrun action: "+repr(a))
'''


def run():
    cases = []
    def case(name, mutate, action, success, message):
        state = copy.deepcopy(BASE)
        mutate(state)
        cases.append((name, state, action, success, message))

    case("old SDK", lambda s: s.update(sdk="26.2"), "check", False, "require 27.1+")
    case("no device type", lambda s: s.update(types={"devicetypes": []}), "check", False, "device type is not installed")
    case("no runtime", lambda s: s.update(runtimes={"runtimes": []}), "check", False, "runtime is required")
    case("valid prerequisites", lambda s: None, "check", True, "prerequisites ready")
    wrong = {"name": "SWC-1079-Duo", "deviceTypeIdentifier": "other", "isAvailable": True}
    case("wrong existing device", lambda s: s.update(devices={"devices": {RUNTIME: [wrong]}}), "test", False, "different type/runtime")
    case("duplicate names", lambda s: s.update(devices={"devices": {RUNTIME: [wrong, wrong]}}), "test", False, "duplicate")
    correct_type = dict(wrong, deviceTypeIdentifier=TYPE)
    case("wrong existing runtime", lambda s: s.update(devices={"devices": {"older-runtime": [correct_type]}}), "test", False, "different type/runtime")

    with tempfile.TemporaryDirectory(prefix="duo-gate-") as temp:
        fake = Path(temp) / "xcrun"
        fake.write_text(FAKE)
        fake.chmod(0o755)
        for name, state, action, success, message in cases:
            env = dict(os.environ, PATH=temp + os.pathsep + os.environ["PATH"], DUO_GATE_FIXTURE=json.dumps(state))
            result = subprocess.run(["bash", str(Path(__file__).with_name("duo-readiness.sh")), action], env=env, capture_output=True, text=True, timeout=10)
            output = result.stdout + result.stderr
            assert (result.returncode == 0) == success and message in output, (name, result.returncode, output)
            print("PASS:", name)
    print(f"{len(cases)} prerequisite cases passed; no simulators changed")


if __name__ == "__main__":
    run()
