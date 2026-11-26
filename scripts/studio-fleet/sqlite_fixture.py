"""Fixture databases that look like the service's on every SQLite build. A test support module,
not a test: run-tests.sh runs only test-*.py.

The service (Node's bundled SQLite) checkpoints and removes -wal and -shm when its last
connection closes. Apple's SQLite on macOS 27 (3.54.0, /usr/bin/python3) keeps both files, so a
fixture written with it would look like a database some process still has open. `close` ends a
fixture's connection the way the service does.
"""
import os


def close(db):
    """Close `db` (a read-write fixture connection) and leave only the main file, as the service
    leaves a database it has stopped using."""
    path = db.execute('PRAGMA database_list').fetchone()[2]
    if db.in_transaction:
        db.commit()
    db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
    db.close()
    for suffix in ('-wal', '-shm'):
        try:
            os.unlink(path + suffix)
        except FileNotFoundError:
            pass



class RunningService(object):
    """`path` held open the way the running service holds it, in a separate process so this
    test's own lock probes cannot drop its locks: -shm stays on disk and initialised. `write`
    runs statements in that process, as the service writes while a reader reads. `stop` closes it."""

    SCRIPT = (
        'import json, sqlite3, sys\n'
        'db = sqlite3.connect(sys.argv[1])\n'
        'db.execute("SELECT count(*) FROM sqlite_master").fetchone()\n'
        'print("ready", flush=True)\n'
        'for line in sys.stdin:\n'
        '    for statement in json.loads(line):\n'
        '        db.execute(statement)\n'
        '    db.commit()\n'
        '    print("done", flush=True)\n'
        'db.close()\n')

    def __init__(self, path):
        import subprocess
        import sys
        self.child = subprocess.Popen([sys.executable, '-c', self.SCRIPT, str(path)],
                                      stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        if self.child.stdout.readline().strip() != 'ready':
            self.child.kill()
            raise AssertionError('The fixture service did not open the database')

    def write(self, *statements):
        import json
        self.child.stdin.write(json.dumps(list(statements)) + '\n')
        self.child.stdin.flush()
        if self.child.stdout.readline().strip() != 'done':
            raise AssertionError('The fixture service could not write')

    def stop(self):
        if self.child.poll() is None:
            self.child.stdin.close()
            self.child.wait(timeout=10)
