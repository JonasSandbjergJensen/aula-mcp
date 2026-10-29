"""Check private-node lifecycle using fake CLI binaries, with no network."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest


class PrivateStartupTest(unittest.TestCase):
    def test_waits_for_login_before_serving_and_stops_daemon(self):
        script = Path(__file__).resolve().parents[2] / "deploy" / "tailscale-start.sh"
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            binary = root / "bin"
            binary.mkdir()
            daemon = binary / "tailscaled"
            daemon.write_text('''#!/usr/bin/env python3
import os, sys, time
from pathlib import Path
root = Path(os.environ["TEST_ROOT"])
root.joinpath("daemon.pid").write_text(str(os.getpid()))
while True: time.sleep(1)
''')
            client = binary / "tailscale"
            client.write_text('''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
root = Path(os.environ["TEST_ROOT"])
args = sys.argv[1:]
with root.joinpath("calls.jsonl").open("a") as output: output.write(json.dumps(args) + "\\n")
if "up" in args:
    if not root.joinpath("first_login").exists():
        root.joinpath("first_login").touch()
        sys.exit(1)
    root.joinpath("authenticated").touch()
if "serve" in args:
    assert root.joinpath("authenticated").exists(), "Serve before login"
    root.joinpath("served").touch()
''')
            sleeper = binary / "sleep"
            sleeper.write_text("#!/bin/sh\nexec /bin/sleep 0.01\n")
            for path in [daemon, client, sleeper]: path.chmod(0o700)
            env = {**os.environ, "PATH": str(binary) + ":" + os.environ["PATH"],
                   "TEST_ROOT": str(root), "AULA_TAILSCALE_STATE_DIR": str(root / "state"),
                   "AULA_TAILSCALE_SOCKET": str(root / "tailscale.sock")}
            process = subprocess.Popen(["bash", str(script)], env=env,
                                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            try:
                deadline = time.monotonic() + 5
                while not (root / "served").exists() and time.monotonic() < deadline:
                    time.sleep(0.02)
                if not (root / "served").exists():
                    process.terminate()
                    log, _ = process.communicate(timeout=5)
                    self.fail("Proxy did not start after login retry: " + log.decode())
                calls = [json.loads(line) for line in (root / "calls.jsonl").read_text().splitlines()]
                ups = [args for args in calls if "up" in args]
                self.assertGreaterEqual(len(ups), 2)
                self.assertIn("--accept-routes=false", ups[-1])
                self.assertIn("--accept-dns=false", ups[-1])
                self.assertIn("--timeout=0s", ups[-1])
                serve = next(args for args in calls if "--bg" in args)
                self.assertIn("http://127.0.0.1:8081", serve)
                self.assertIn("--https=443", serve)
                self.assertFalse(any("funnel" in args for args in calls))
                self.assertEqual((root / "state").stat().st_mode & 0o777, 0o700)
            finally:
                process.terminate()
                output, _ = process.communicate(timeout=5)
            daemon_pid = int((root / "daemon.pid").read_text())
            with self.assertRaises(ProcessLookupError): os.kill(daemon_pid, 0)


if __name__ == "__main__": unittest.main()
