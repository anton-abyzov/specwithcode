import { describe, expect, it } from "vite-plus/test";

import { sshRemoteTarget, sshTargetsInScript } from "./sshTargets.ts";

const server = (user: string | null, host: string, variable: string | null = null) => ({
  kind: "server" as const,
  user,
  host,
  variable,
});
const targets = (text: string) => sshTargetsInScript(text).targets;

describe("sshTargetsInScript", () => {
  it("reads a written destination of ssh, scp and rsync", () => {
    expect(targets("ssh root@203.0.113.7 uptime\n")).toEqual([server("root", "203.0.113.7")]);
    expect(targets("scp -r -P 2222 dist deploy@build.example.com:/srv/app\n")).toEqual([
      server("deploy", "build.example.com"),
    ]);
    expect(targets("rsync -az -e 'ssh -p 22' out/ web@files.example.com:site/\n")).toEqual([
      server("web", "files.example.com"),
    ]);
  });

  it("fills variables from plain assignments in the same file", () => {
    const script = `#!/bin/bash
WORKERS=("$@")
if [ $# -eq 0 ]; then
  WORKERS=(203.0.113.10 203.0.113.30)
fi
SSH_USER="\${SSH_USER:-root}"
for WORKER_IP in "\${WORKERS[@]}"; do
  ssh "\${SSH_USER}@\${WORKER_IP}" "mkdir -p /opt/app"
  scp -r src "\${SSH_USER}@\${WORKER_IP}:/opt/app/"
done
`;
    expect(targets(script)).toEqual([
      server("root", "203.0.113.10", "WORKER_IP"),
      server("root", "203.0.113.30", "WORKER_IP"),
    ]);
  });

  it("leaves a variable unknown when the file writes it twice or from a command", () => {
    const named = (variable: string) => [{ kind: "variable", user: "root", host: null, variable }];
    expect(targets("H=a.example.com\nH=b.example.com\nssh root@$H true\n")).toEqual(named("H"));
    expect(targets("H=a.example.com\nH=$(pick)\nssh root@$H true\n")).toEqual(named("H"));
    expect(
      targets('L=(a.example.com)\nL=($(list))\nfor H in "${L[@]}"; do\nssh root@$H true\ndone\n'),
    ).toEqual(named("H"));
    // The same value twice is one value.
    expect(targets("H=a.example.com\nH=a.example.com\nssh root@$H true\n")).toEqual([
      server("root", "a.example.com", "H"),
    ]);
  });

  it("names the variable when the file does not say what it holds", () => {
    expect(targets('ssh "deploy@$TARGET_HOST" true\n')).toEqual([
      { kind: "variable", user: "deploy", host: null, variable: "TARGET_HOST" },
    ]);
    expect(targets('HOST=$(terraform output -raw ip)\nssh "$USER_NAME@$HOST" true\n')).toEqual([
      { kind: "variable", user: null, host: null, variable: "HOST" },
    ]);
  });

  it("is not fooled by an array expansion, an option value or a script with its own key", () => {
    // The pattern this replaced read `[@]` as user@host.
    expect(targets('/usr/bin/ssh "${ssh_opts[@]}" "$target" "curl -s localhost"\n')).toEqual([]);
    expect(targets("ssh -o User=a@b.example.com -i key@file host true\n")).toEqual([]);
    expect(targets('ssh -F /dev/null -i "$fleet/id_ed25519" peer@198.51.100.4 true\n')).toEqual([]);
    expect(targets("# mail ops@example.com before the first ssh\necho ssh\n")).toEqual([]);
  });

  it("drops anything that could bend a copied command", () => {
    for (const hostile of [
      "ssh root@-oProxyCommand=evil true",
      "ssh 'root@host;rm -rf ~' true",
      "ssh root@host$(id) true",
      "ssh root@h\u043Est.example.com true",
      "ssh root@host..example.com true",
      "ssh root@[::1] true",
      "ssh root@host.example.com. true",
      "ssh -oProxyCommand=x@y true",
      `ssh root@${"a".repeat(40)} true`,
    ])
      expect(targets(`${hostile}\n`), hostile).toEqual([]);
    // A hostile user is dropped; the host still shows, without it.
    expect(targets("U='a b'\nssh $U@ok.example.com true\n")).toEqual([
      server(null, "ok.example.com"),
    ]);
    expect(targets("H='x;y'\nssh root@$H true\n")).toEqual([
      { kind: "variable", user: "root", host: null, variable: "H" },
    ]);
    expect(targets("H=-oProxyCommand=x\nssh root@$H true\n")).toEqual([
      { kind: "variable", user: "root", host: null, variable: "H" },
    ]);
  });

  it("leaves a variable unknown for every other way a script can write it", () => {
    const named = [{ kind: "variable", user: "root", host: null, variable: "H" }];
    for (const write of [
      "declare H=evil.example.com",
      "declare -r H=evil.example.com",
      "typeset H=evil.example.com",
      "H+=.evil.example.com",
      "read H",
      "read -r A H",
      'read -p "Host: " H',
      "read -t 5 H",
      "read -n 1 H",
      "read -d '' H",
      "read -u 3 H",
      "mapfile -t H < hosts.txt",
      "readarray H < hosts.txt",
      "printf -v H '%s' evil.example.com",
      "unset H",
      "select H in a b; do break; done",
      'while getopts "h:" H; do :; done',
      "declare -n R=H",
      "local H",
      "export H",
      ': "${H:=evil.example.com}"',
      'echo "${H=evil.example.com}"',
      "eval 'H=evil.example.com'",
      "source ./hosts.env",
      ". ./hosts.env",
      "true && . ./hosts.env",
      "if [ -f hosts.env ]; then . ./hosts.env; fi",
      "for f in a; do . ./hosts.env; done",
      "{ . ./hosts.env; }",
      "command . ./hosts.env",
      '\\eval "$CODE"',
      '"eval" "$CODE"',
      '"source" ./hosts.env',
      'for kv in "$@"; do export "$kv"; done',
      "export $(cat hosts.env)",
      'while read line; do export "$line"; done < hosts.env',
      "declare -n R=$TARGET",
      "local -n R=TARGET",
      "declare -g -n R=$TARGET",
      "typeset -g -n R=TARGET",
      "printf -v \"$ref\" '%s' evil.example.com",
      "H=$1",
      'H="${OTHER:-evil.example.com}"',
      "X=1; H=evil.example.com",
      "H=evil.example.com true",
      "H[0]=evil.example.com",
      `H=good.example.com ${"x".repeat(2100)}`,
    ])
      expect(targets(`H=good.example.com\n${write}\nssh root@$H true\n`), write).toEqual(named);
    expect(targets("declare -r H=good.example.com\nssh root@$H true\n")).toEqual([
      server("root", "good.example.com", "H"),
    ]);
  });

  it("reads the rest of a loop line, and a list a command or a file fills", () => {
    const named = (variable: string) => [{ kind: "variable", user: "root", host: null, variable }];
    expect(
      targets("for H in good.example.com; do H=evil.example.com; ssh root@$H true; done\n"),
    ).toEqual(named("H"));
    expect(
      targets(
        'L=(good.example.com)\nmapfile -t L < hosts.txt\nfor H in "${L[@]}"; do\nssh root@$H true\ndone\n',
      ),
    ).toEqual(named("H"));
    expect(targets("for H in a.example.com b.example.com; do ssh root@$H true; done\n")).toEqual([
      server("root", "a.example.com", "H"),
      server("root", "b.example.com", "H"),
    ]);
  });

  it("takes a default only from the variable itself or the caller's argument", () => {
    const named = [{ kind: "variable", user: "root", host: null, variable: "H" }];
    const good = [server("root", "good.example.com", "H")];
    const ssh = "\nssh root@$H true\n";
    expect(targets(`H="\${H:-good.example.com}"${ssh}`)).toEqual(good);
    expect(targets(`H="\${1:-good.example.com}"${ssh}`)).toEqual(good);
    expect(targets(`H=$1\nH=good.example.com${ssh}`)).toEqual(good);
    expect(targets(`H="\${DEPLOY_HOST:-good.example.com}"${ssh}`)).toEqual(named);
    expect(targets(`OTHER=evil.example.com\nH="\${OTHER:-good.example.com}"${ssh}`)).toEqual(named);
    expect(targets(`shift\nH="\${1:-good.example.com}"${ssh}`)).toEqual(named);
    expect(
      targets(`while [ $# -gt 0 ]; do shift; done\nH="\${1:-good.example.com}"${ssh}`),
    ).toEqual(named);
    // `set --` decides what `$1` is, so the written default no longer stands in for it.
    expect(targets(`set -- evil.example.com\nH="\${1:-good.example.com}"${ssh}`)).toEqual(named);
  });

  it("does not take a here-document's body for the script's own assignments", () => {
    const named = [{ kind: "variable", user: "root", host: null, variable: "H" }];
    expect(targets("cat > remote.sh <<'EOF'\nH=good.example.com\nEOF\nssh root@$H true\n")).toEqual(
      named,
    );
    expect(
      targets("H=good.example.com\ncat <<-EOF\n\tH=evil.example.com\n\tEOF\nssh root@$H true\n"),
    ).toEqual(named);
    // Two opened on one line: both bodies are text, in order.
    for (const open of ["cat <<A <<B", "cat >a <<'A' >b <<'B'", "cat <<A && cat <<B"])
      expect(targets(`${open}\nfirst\nA\nH=evil.example.com\nB\nssh root@$H true\n`), open).toEqual(
        named,
      );
    // After the closing word the script's own lines count again; `<<<` opens nothing.
    expect(
      targets("cat <<EOF\nhello\nEOF\nH=good.example.com\ngrep x <<< y\nssh root@$H true\n"),
    ).toEqual([server("root", "good.example.com", "H")]);
  });

  it("finds the destination behind options kept in a variable or written together", () => {
    const good = [server("root", "good.example.com")];
    expect(targets("ssh $OPTS root@good.example.com true\n")).toEqual(good);
    expect(targets('ssh "${OPTS[@]}" root@good.example.com true\n')).toEqual(good);
    expect(targets("ssh -vp 2222 root@good.example.com true\n")).toEqual(good);
    expect(sshTargetsInScript('ssh "$target" mail ops@old.example.com\n')).toEqual({
      targets: [],
      more: false,
      used: false,
    });
  });

  it("takes only ssh's first word as its destination", () => {
    expect(sshTargetsInScript("ssh bastion sendmail ops@old.example.com\n")).toEqual({
      targets: [],
      more: false,
      used: false,
    });
    expect(targets("ssh -p 22 root@a.example.com mail ops@b.example.com\n")).toEqual([
      server("root", "a.example.com"),
    ]);
    expect(targets("scp a.txt root@a.example.com:/tmp root@b.example.com:/tmp\n")).toEqual([
      server("root", "a.example.com"),
      server("root", "b.example.com"),
    ]);
  });

  it("says a script connects even when the place cannot be read", () => {
    for (const script of [
      "ssh root@[::1] true",
      "ssh root@my_host true",
      "ssh root@host.example.com. true",
      "ssh ssh://root@host.example.com:2222 true",
      "ssh root@0177.0.0.1 true",
      "ssh root@2130706433 true",
      "ssh root@0x7f000001 true",
    ])
      expect(sshTargetsInScript(`${script}\n`), script).toEqual({
        targets: [],
        more: false,
        used: true,
      });
    for (const script of [
      '/usr/bin/ssh "${ssh_opts[@]}" "$target" true',
      "ssh -o User=a@b.example.com host true",
      "# ssh root@build.example.com true",
      "echo ops@example.com",
    ])
      expect(sshTargetsInScript(`${script}\n`).used, script).toBe(false);
  });

  it("reads one host once whatever its case, and skips comment lines", () => {
    expect(targets("ssh root@Build.Example.com a\nssh root@build.example.com b\n")).toEqual([
      server("root", "build.example.com"),
    ]);
    expect(targets("  # ssh root@old.example.com true\nssh root@new.example.com true\n")).toEqual([
      server("root", "new.example.com"),
    ]);
  });

  it("stays quick on a long line built to slow the patterns", () => {
    for (const unit of ["export ", "declare -a ", "ssh a@b ", ". ", "<<A ", "${A:=", "read "]) {
      const script = `H=good.example.com\n${unit.repeat(Math.ceil(250_000 / unit.length))}\nssh root@$H true\n`;
      const started = performance.now();
      sshTargetsInScript(script);
      expect(performance.now() - started, unit).toBeLessThan(1500);
    }
  });

  it("stops at twelve targets", () => {
    const script = Array.from(
      { length: 30 },
      (_, index) => `ssh root@h${index}.example.com true`,
    ).join("\n");
    expect(sshTargetsInScript(script)).toMatchObject({ more: true });
    expect(targets(script)).toHaveLength(12);
    expect(sshTargetsInScript("ssh root@one.example.com true\n").more).toBe(false);
  });
});

describe("sshRemoteTarget", () => {
  it("reads SSH remotes and nothing else", () => {
    expect(sshRemoteTarget("git@github.com:acme/app.git")).toEqual({
      kind: "git",
      user: "git",
      host: "github.com",
      variable: null,
    });
    expect(sshRemoteTarget("ssh://git@ssh.dev.azure.com:22/v3/acme/app")).toMatchObject({
      host: "ssh.dev.azure.com",
    });
    expect(sshRemoteTarget("ssh://Git.Example.com/acme/app")).toMatchObject({
      user: null,
      host: "git.example.com",
    });
    expect(sshRemoteTarget("https://user:secret@github.com/acme/app.git")).toBeNull();
    expect(sshRemoteTarget("/srv/git/app.git")).toBeNull();
    expect(sshRemoteTarget("C:/repos/app")).toBeNull();
    expect(sshRemoteTarget("github.com:acme/app.git")).toBeNull();
    expect(sshRemoteTarget("ssh://git@-oProxyCommand=x/acme")).toBeNull();
    // A password or token in the URL is never read as a host, and never returned.
    const secret = `${"gl"}pat-${"t".repeat(20)}`;
    expect(sshRemoteTarget(`ssh://oauth2:${secret}@gitlab.com/g/p`)).toBeNull();
    expect(sshRemoteTarget("ssh://a@b@gitlab.com/g/p")).toBeNull();
    expect(sshRemoteTarget("ssh://@gitlab.com/g/p")).toBeNull();
    expect(sshRemoteTarget("ssh://git@gitlab.com:2222/g/p")).toMatchObject({ host: "gitlab.com" });
    expect(sshRemoteTarget("ssh://git@2130706433/g/p")).toBeNull();
    // A token in the user position is not a user name: the host stays, the token does not.
    expect(sshRemoteTarget(`ssh://${secret}@gitlab.com/g/p`)).toEqual({
      kind: "git",
      user: null,
      host: "gitlab.com",
      variable: null,
    });
  });
});
