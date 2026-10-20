#!/bin/sh
# Runs the bundled `specwithcode provision` on a test machine over SSH.
#   scripts/studio-provision/vm-run.sh <ssh-destination> <artifact-dir> <label> [provision flags...]
# SSH options come from $PROVISION_SSH_OPTS. The provision bundle must exist
# (node scripts/studio-provision/bundle.mjs). The test machine gets a private Node.js 22
# under /tmp/swc-harness-node, checked against nodejs.org's SHASUMS256.txt and kept off PATH,
# so it does not count as an installed Node.js.
set -eu
dest=$1 artifacts=$2 label=$3
shift 3
here=$(cd "$(dirname "$0")" && pwd)
bundle="$here/dist/provision.mjs"
[ -f "$bundle" ] || { echo "missing $bundle; run bundle.mjs first" >&2; exit 2; }
mkdir -p "$artifacts"
# shellcheck disable=SC2086
ssh_() { ssh ${PROVISION_SSH_OPTS:-} "$dest" "$@"; }
# shellcheck disable=SC2086
scp ${PROVISION_SSH_OPTS:-} -q "$bundle" "$dest:/tmp/swc-provision.mjs"
ssh_ 'set -eu
v=22.20.0
case $(uname -m) in x86_64) a=x64 ;; aarch64) a=arm64 ;; *) exit 3 ;; esac
d=/tmp/swc-harness-node
if [ ! -x $d/bin/node ]; then
  cd /tmp
  curl -fsSLO https://nodejs.org/dist/v$v/node-v$v-linux-$a.tar.xz
  curl -fsSL https://nodejs.org/dist/v$v/SHASUMS256.txt | grep " node-v$v-linux-$a.tar.xz\$" | sha256sum -c - >&2
  mkdir -p $d && tar -xJf node-v$v-linux-$a.tar.xz -C $d --strip-components=1
fi'
quoted=''
for arg in "$@"; do quoted="$quoted '$arg'"; done
set +e
ssh_ "/tmp/swc-harness-node/bin/node --no-warnings /tmp/swc-provision.mjs provision$quoted" \
  >"$artifacts/$label.out" 2>"$artifacts/$label.err"
code=$?
set -e
echo "$code" >"$artifacts/$label.code"
echo "$label: exit $code ($artifacts/$label.out)"
