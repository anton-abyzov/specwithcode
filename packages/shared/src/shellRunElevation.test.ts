import { describe, expect, it } from "vite-plus/test";

import {
  isSystemPath,
  shellRunElevation,
  shellRunNeedsElevationConfirm,
} from "./shellRunElevation.ts";

const REPORTED_BLOCK = `sudo -u _cmiodalassistants defaults write com.apple.cameracapture "global/continuitycapture/enabled-on-mac" -bool true
sudo cp /Library/Preferences/com.apple.networkextension.plist /Library/Preferences/com.apple.networkextension.plist.bak-rapportd
sudo python3 -c '
import plistlib
p = "/Library/Preferences/com.apple.networkextension.plist"
d = plistlib.load(open(p, "rb"))
plistlib.dump(d, open(p, "wb"), fmt=plistlib.FMT_BINARY)
'`;

describe("shellRunElevation", () => {
  it("reads the block from the November 20 report as administrator work on system files", () => {
    expect(shellRunElevation(REPORTED_BLOCK)).toEqual({
      administrator: true,
      sudo: true,
      systemChanges: [
        "/Library/Preferences/com.apple.networkextension.plist",
        "/Library/Preferences/com.apple.networkextension.plist.bak-rapportd",
      ],
    });
  });

  it.each([
    "sudo ls",
    "doas reboot",
    "/usr/bin/sudo -n true",
    "cd /tmp && sudo make install",
    "make build; sudo make install",
    "cat list.txt | sudo tee out.txt",
    "echo $(sudo cat secret)",
    "FOO=1 sudo -E env",
    "if true; then sudo ls; fi",
    "npm run build \\\n  && sudo npm link",
    "time sudo ls",
    "'sudo' ls",
    'echo "$(echo "ok"; sudo rm -rf /etc/hosts)"',
    '"env" sudo id',
    '"command" sudo id',
    "xargs --weird 1 sudo rm",
    "osascript -e 'do shell script \"x\" with Administrator Privileges'",
    '"sudo" ls',
    "\\sudo ls",
    'echo "$(sudo id)"',
    'echo "`sudo id`"',
    'echo "say \\"hi\\""; sudo ls',
    "env -i sudo ls",
    "command -p sudo ls",
    "ls | xargs -n 1 sudo rm",
    "time -p sudo ls",
    "caffeinate -i sudo make install",
    "nice -n 5 sudo ls",
    "sudoedit /etc/hosts",
    "su -c 'make install'",
    "pkexec make install",
    "osascript -e 'do shell script \"make install\" with administrator privileges'",
  ])("finds the administrator command in %j", (code) => {
    expect(shellRunElevation(code).administrator).toBe(true);
  });

  it.each([
    "# sudo make install\nmake install",
    'echo "run sudo make install next"',
    "echo 'sudo'",
    "git commit -m 'drop sudo'",
    "man sudo",
    "brew install sudo-touchid",
    "echo done # then sudo reboot",
    "ls ./sudo",
    'echo "it costs $(echo 5) and no sudo"',
    "env FOO=1 make",
  ])("does not take a mention for a command in %j", (code) => {
    expect(shellRunElevation(code).administrator).toBe(false);
  });

  it("names what a block changes in the system", () => {
    expect(shellRunElevation("sudo rm -rf /Library/Caches/com.example").systemChanges).toEqual([
      "/Library/Caches/com.example",
    ]);
    expect(shellRunElevation("echo 127.0.0.1 example >> /etc/hosts").systemChanges).toEqual([
      "/etc/hosts",
    ]);
    expect(shellRunElevation("sudo tee /etc/pam.d/sudo_local < local").systemChanges).toEqual([
      "/etc/pam.d/sudo_local",
    ]);
    expect(
      shellRunElevation(
        "sudo defaults write /Library/Preferences/com.apple.loginwindow Hide -bool true",
      ).systemChanges,
    ).toEqual(["/Library/Preferences/com.apple.loginwindow"]);
    expect(
      shellRunElevation("sudo launchctl bootout system /Library/LaunchDaemons/x.plist")
        .systemChanges,
    ).toEqual(["launchctl bootout"]);
    expect(shellRunElevation("csrutil disable").systemChanges).toEqual(["csrutil disable"]);
    expect(shellRunElevation("sudo spctl --master-disable").systemChanges).toEqual([
      "spctl --master-disable",
    ]);
    expect(shellRunElevation("sudo pfctl -f /etc/pf.conf").systemChanges).toEqual(["pfctl -f"]);
    expect(shellRunElevation("sudo dscl . -create /Users/guest").systemChanges).toEqual(["dscl"]);
    expect(shellRunElevation("find /Library/Logs -name '*.log' -delete").systemChanges).toEqual([
      "/Library/Logs",
    ]);
  });

  it("tells the machine's prompt apart from other ways to become an administrator", () => {
    expect(shellRunElevation("sudo ls").sudo).toBe(true);
    expect(shellRunElevation("su -c ls").sudo).toBe(false);
    expect(shellRunElevation("doas ls").sudo).toBe(false);
    expect(shellRunElevation("pkexec ls").sudo).toBe(false);
  });

  it("reads past options and quotes to the path a command changes", () => {
    expect(shellRunElevation("sudo --user root rm /etc/hosts").systemChanges).toEqual([
      "/etc/hosts",
    ]);
    expect(shellRunElevation("sudo -Hu root rm /etc/hosts").systemChanges).toEqual(["/etc/hosts"]);
    expect(shellRunElevation("echo x >| /etc/hosts").systemChanges).toEqual(["/etc/hosts"]);
    expect(shellRunElevation("sudoedit /etc/hosts").systemChanges).toEqual(["/etc/hosts"]);
    expect(shellRunElevation("sed -i '' s/a/b/ /etc/hosts").systemChanges).toEqual(["/etc/hosts"]);
    expect(shellRunElevation("sudo pfctl -sr -f /etc/pf.conf").systemChanges).toEqual(["pfctl -f"]);
    expect(shellRunElevation("sudo pfctl -e").systemChanges).toEqual(["pfctl -e"]);
    expect(
      shellRunElevation("dscl . -read /Users/a; dscl . -passwd /Users/a x").systemChanges,
    ).toEqual(["dscl"]);
  });

  it.each([
    ['echo "$(echo "ok"; sudo rm -rf /etc/hosts)"', "/etc/hosts"],
    ["nice -n 5 launchctl disable system/x", "launchctl disable"],
    ["timeout 30 pfctl -e", "pfctl -e"],
    ["timeout -s KILL 30 pfctl -e", "pfctl -e"],
    ["env -u FOO networksetup -setdnsservers Wi-Fi 1.1.1.1", "networksetup -setdnsservers"],
    ["caffeinate -t 60 pmset -a sleep 0", "pmset -a"],
    ["xargs -I cat rm /etc/hosts", "/etc/hosts"],
    ["find /etc -okdir rm {} +", "/etc"],
    ["dseditgroup -o edit -a bob -t user read", "dseditgroup -o"],
    ["defaults -currentHost write /Library/Preferences/x k v", "/Library/Preferences/x"],
    ["doas rm /etc/hosts", "/etc/hosts"],
    ["sudo networksetup -setdnsservers Wi-Fi 1.1.1.1", "networksetup -setdnsservers"],
    ["sudo scutil --set HostName box", "scutil --set"],
    ["sudo pmset -a sleep 0", "pmset -a"],
    ["sudo nvram boot-args=-v", "nvram boot-args=-v"],
    ["sudo systemsetup -setremotelogin on", "systemsetup -setremotelogin"],
    ["sudo tmutil disable", "tmutil disable"],
    ["diskutil eraseDisk APFS x disk4", "diskutil eraseDisk"],
    ["sudo softwareupdate -ia", "softwareupdate -ia"],
    ["sudo dseditgroup -o edit -a anton -t user admin", "dseditgroup -o"],
    ["sudo sysadminctl -addUser guest", "sysadminctl -addUser"],
  ])("names the settings change in %j", (code, change) => {
    expect(shellRunElevation(code).systemChanges).toEqual([change]);
  });

  it.each([
    "awk '{print $1}' /etc/hosts",
    "sed -n 1,5p /etc/hosts",
    "jq . /etc/config.json",
    "sort /etc/hosts | uniq",
    "networksetup -getdnsservers Wi-Fi",
    "networksetup -listallnetworkservices",
    "scutil --get HostName",
    "pmset -g",
    "nvram -p",
    "systemsetup -getremotelogin",
    "tmutil listbackups",
    "diskutil list",
    "diskutil apfs list",
    "softwareupdate -l",
    "dseditgroup -o read admin",
    "pfctl -sr",
    "pfctl -v -s rules",
    "cat /etc/hosts",
    "ls -la /Library/Preferences",
    "sudo cat /etc/sudoers",
    "grep -r rapportd /Library/Preferences 2>/dev/null",
    "plutil -p /Library/Preferences/com.apple.networkextension.plist",
    "defaults read /Library/Preferences/com.apple.loginwindow",
    "defaults write com.apple.dock autohide -bool true",
    "launchctl list",
    "launchctl print system/com.apple.rapportd",
    "csrutil status",
    "spctl --status",
    "pfctl -s rules",
    "dscl . -read /Users/anton",
    "find /Library/Logs -name '*.log'",
    "cp notes.txt /usr/local/share/notes.txt",
    "echo hi > /private/tmp/out.txt",
    "curl -o /tmp/x https://example.com/etc/hosts",
    "cat /etc/hosts > hosts.copy",
    "ls 2>&1",
  ])("sees no system change in %j", (code) => {
    expect(shellRunElevation(code).systemChanges).toEqual([]);
  });

  it("handles command substitutions inside double quotes without misreading trailing text", () => {
    expect(shellRunElevation('echo "$(echo ok) sudo rm -rf /etc/hosts"')).toEqual({
      administrator: false,
      sudo: false,
      systemChanges: [],
    });
    expect(shellRunElevation('echo "\\$(safe) $(sudo id)"')).toEqual({
      administrator: true,
      sudo: true,
      systemChanges: [],
    });
    expect(shellRunElevation('echo "prefix `sudo id` suffix"')).toEqual({
      administrator: true,
      sudo: true,
      systemChanges: [],
    });
  });

  it("treats dseditgroup without -o as a system change", () => {
    expect(shellRunElevation("dseditgroup read")).toEqual({
      administrator: false,
      sudo: false,
      systemChanges: ["dseditgroup read"],
    });
  });

  it("asks first for administrator work or a system change, and for nothing else", () => {
    expect(shellRunNeedsElevationConfirm(shellRunElevation("sudo ls"))).toBe(true);
    expect(shellRunNeedsElevationConfirm(shellRunElevation("csrutil disable"))).toBe(true);
    expect(shellRunNeedsElevationConfirm(shellRunElevation("npm test"))).toBe(false);
  });

  it("keeps folders people own out of the system set", () => {
    expect(isSystemPath("/Library/Preferences/x.plist")).toBe(true);
    expect(isSystemPath("/usr/bin/python3")).toBe(true);
    expect(isSystemPath("/usr/local/bin/tool")).toBe(false);
    expect(isSystemPath("/var/folders/ab/T/x")).toBe(false);
    expect(isSystemPath("/Users/anton/Library/Preferences/x.plist")).toBe(false);
    expect(isSystemPath("/Libraryish")).toBe(false);
  });
});
