"""Test helpers for the R2 channel feeds (increment 1239): a release's assets on disk, published with
scripts/release/r2_publish.py into a folder store, and that folder served over loopback HTTP the way
R2's public bucket serves it. Used by test-channel-feed-skew.py, test-candidate-ignored-off-canary.py
and scripts/release/test-stable-rollback.py. Nothing here reaches a real bucket or GitHub."""
import functools
import http.server
import importlib.util
import json
import pathlib
import sys
import threading

FLEET = pathlib.Path(__file__).resolve().parent.parent
RELEASE = FLEET.parent / 'release'


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, str(path))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


if str(FLEET) not in sys.path:
    sys.path.insert(0, str(FLEET))
agent_fixture = load('agent_channel_fixture', FLEET / 'test-update-agent.py')
r2_publish = load('r2_publish_channel_fixture', RELEASE / 'r2_publish.py')


def release_dir(fake, version, out, on_github=False, **options):
    """Writes the assets of a fixture release (FakeGitHub.add_release) to `out`, with the plan listed
    in SHA256SUMS as release.sh's plan stage lists it. The release stays on the fake GitHub only
    when `on_github`. Returns `out`."""
    made = fake.add_release(version, **options)
    if not on_github:
        fake.releases.remove(made['release'])
    out = pathlib.Path(out)
    out.mkdir(parents=True, exist_ok=True)
    for asset in made['release']['assets']:
        (out / asset['name']).write_bytes(fake.blobs[asset['id']])
    plan = out / r2_publish.PLAN
    sums = (out / r2_publish.SUMS).read_text()
    (out / r2_publish.SUMS).write_text(sums + '%s  %s\n' % (r2_publish.sha256_file(plan), r2_publish.PLAN))
    return out


class Feed(object):
    """A folder store served read-only over loopback HTTP; `requests` records (path, Authorization)."""

    def __init__(self, root):
        self.root = pathlib.Path(root)
        self.store = r2_publish.LocalStore(self.root)
        self.requests = []
        feed = self

        class Handler(http.server.SimpleHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                feed.requests.append((self.path, self.headers.get('Authorization')))
                return http.server.SimpleHTTPRequestHandler.do_GET(self)

        self.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(root)))
        self.url = 'http://127.0.0.1:%d/' % self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()

    def pointer(self, name):
        path = self.root / name
        return json.loads(path.read_text()) if path.is_file() else None

    def fetched(self, prefix):
        return [path for path, _ in self.requests if path.startswith('/' + prefix)]
