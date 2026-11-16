import { describe, expect, it } from "vite-plus/test";

import { sshRemoteTarget, sshTargetsInScript } from "./sshTargets.ts";

const server = (user: string | null, host: string) => ({
  kind: "server" as const,
  user,
  host,
  variable: null,
});

describe("sshTargetsInScript", () => {
  it("reads a written destination of ssh, scp and rsync", () => {
    expect(sshTargetsInScript("ssh root@203.0.113.7 uptime\n")).toEqual([server("root", "203.0.113.7")]);
    expect(sshTargetsInScript("scp -r -P 2222 dist deploy@build.example.com:/srv/app\n")).toEqual([
      server("deploy", "build.example.com"),
    ]);
    expect(sshTargetsInScript("rsync -az -e 'ssh -p 22' out/ web@files.example.com:site/\n")).toEqual([
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
    expect(sshTargetsInScript(script)).toEqual([
      server("root", "203.0.113.10"),
      server("root", "203.0.113.30"),
    ]);
  });

  it("names the variable when the file does not say what it holds", () => {
    expect(sshTargetsInScript('ssh "deploy@$TARGET_HOST" true\n')).toEqual([
      { kind: "variable", user: "deploy", host: null, variable: "TARGET_HOST" },
    ]);
    expect(sshTargetsInScript('HOST=$(terraform output -raw ip)\nssh "$USER_NAME@$HOST" true\n')).toEqual([
      { kind: "variable", user: null, host: null, variable: "HOST" },
    ]);
  });

  it("is not fooled by an array expansion, an option value or a script with its own key", () => {
    // The pattern this replaced read `[@]` as user@host.
    expect(sshTargetsInScript('/usr/bin/ssh "${ssh_opts[@]}" "$target" "curl -s localhost"\n')).toEqual([]);
    expect(sshTargetsInScript("ssh -o User=a@b.example.com -i key@file host true\n")).toEqual([]);
    expect(
      sshTargetsInScript('ssh -F /dev/null -i "$fleet/id_ed25519" peer@198.51.100.4 true\n'),
    ).toEqual([]);
    expect(sshTargetsInScript("# mail ops@example.com before the first ssh\necho ssh\n")).toEqual([]);
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
      expect(sshTargetsInScript(`${hostile}\n`), hostile).toEqual([]);
    // A hostile user is dropped; the host still shows, without it.
    expect(sshTargetsInScript("U='a b'\nssh $U@ok.example.com true\n")).toEqual([
      server(null, "ok.example.com"),
    ]);
    expect(sshTargetsInScript("H='x;y'\nssh root@$H true\n")).toEqual([
      { kind: "variable", user: "root", host: null, variable: "H" },
    ]);
  });

  it("stops at twelve targets", () => {
    const script = Array.from({ length: 30 }, (_, index) => `ssh root@h${index}.example.com true`).join("\n");
    expect(sshTargetsInScript(script)).toHaveLength(12);
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
  });
});
