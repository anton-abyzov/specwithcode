import { describe, expect, it } from "vite-plus/test";

/**
 * The per-OS readers behind the exclusive-control rule, on recorded output with
 * made-up names: what counts as another principal's right to change a folder.
 */

interface Readers {
  darwinAclGrantsOthers: (listing: string, user: string) => boolean;
  windowsAccess: (
    sddl: string,
    userSid: string,
  ) => {
    readonly owner: "user" | "trusted" | "other";
    readonly othersMayWrite: boolean;
    readonly othersMayReplace: boolean;
  };
}
// Loaded per test, so each one fails on its own while the module does not exist.
const readers = async () => (await import("./confinement.ts" as string)) as Readers;

const HEAD = "drwxr-xr-x+ 5 sam  staff  160 Jan  1 10:00 /folder\n";
const USER_SID = "S-1-5-21-1111111111-2222222222-3333333333-1001";
const OTHER_SID = "S-1-5-21-1111111111-2222222222-3333333333-1002";

describe("macOS ACL entries", () => {
  it("a folder with no ACL grants nothing", async () => {
    const { darwinAclGrantsOthers } = await readers();
    expect(
      darwinAclGrantsOthers("drwx------  5 sam  staff  160 Jan  1 10:00 /folder\n", "sam"),
    ).toBe(false);
  });

  it("a deny entry never fails a folder: every home folder carries one", async () => {
    const { darwinAclGrantsOthers } = await readers();
    expect(darwinAclGrantsOthers(`${HEAD} 0: group:everyone deny delete\n`, "sam")).toBe(false);
  });

  it("the user's own allow entry is not another principal", async () => {
    const { darwinAclGrantsOthers } = await readers();
    expect(darwinAclGrantsOthers(`${HEAD} 0: user:sam allow add_file,delete_child\n`, "sam")).toBe(
      false,
    );
  });

  it("another principal's read-only entry grants nothing", async () => {
    const { darwinAclGrantsOthers } = await readers();
    expect(darwinAclGrantsOthers(`${HEAD} 0: user:alex allow list,search,readattr\n`, "sam")).toBe(
      false,
    );
  });

  it.each([
    "add_file",
    "add_subdirectory",
    "delete",
    "delete_child",
    "write",
    "append",
    "writesecurity",
    "chown",
  ])("another principal allowed %s fails the folder", async (right) => {
    const { darwinAclGrantsOthers } = await readers();
    expect(
      darwinAclGrantsOthers(
        `${HEAD} 0: group:everyone deny delete\n 1: user:alex allow list,${right}\n`,
        "sam",
      ),
    ).toBe(true);
    expect(darwinAclGrantsOthers(`${HEAD} 0: group:staff allow ${right}\n`, "sam")).toBe(true);
  });
});

describe("Windows owner and DACL", () => {
  it("the user, SYSTEM and Administrators may hold every right", async () => {
    const { windowsAccess } = await readers();
    expect(
      windowsAccess(
        `O:${USER_SID}G:DUD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;${USER_SID})`,
        USER_SID,
      ),
    ).toMatchObject({ owner: "user", othersMayWrite: false });
    expect(windowsAccess("O:BAG:SYD:(A;;FA;;;SY)", USER_SID).owner).toBe("trusted");
  });

  it("another owner is named", async () => {
    const { windowsAccess } = await readers();
    expect(windowsAccess(`O:${OTHER_SID}G:DUD:(A;;FA;;;SY)`, USER_SID).owner).toBe("other");
  });

  it("another principal's read and execute grants nothing", async () => {
    const { windowsAccess } = await readers();
    expect(
      windowsAccess(`O:${USER_SID}D:(A;OICI;0x1200a9;;;BU)(A;;FR;;;WD)`, USER_SID).othersMayWrite,
    ).toBe(false);
  });

  it("the right to add a folder is not the right to replace one", async () => {
    const { windowsAccess } = await readers();
    expect(windowsAccess("O:BAD:(A;;LC;;;AU)(A;OICIIO;GA;;;CO)", USER_SID)).toEqual({
      owner: "trusted",
      othersMayWrite: true,
      othersMayReplace: false,
    });
  });

  it("a deny entry never fails a folder", async () => {
    const { windowsAccess } = await readers();
    expect(windowsAccess(`O:${USER_SID}D:(D;;FA;;;WD)`, USER_SID).othersMayWrite).toBe(false);
  });

  it.each([
    ["full control", "FA"],
    ["modify", "0x1301bf"],
    ["generic write", "GW"],
    ["generic all", "GA"],
    ["delete", "SD"],
    ["delete child", "DT"],
    ["add file", "DC"],
    ["add subfolder", "LC"],
    ["change permissions", "WD"],
    ["take ownership", "WO"],
  ])("another principal allowed %s fails the folder", async (_name, rights) => {
    const { windowsAccess } = await readers();
    expect(
      windowsAccess(`O:${USER_SID}D:(A;;FA;;;SY)(A;OICI;${rights};;;${OTHER_SID})`, USER_SID)
        .othersMayWrite,
    ).toBe(true);
    expect(windowsAccess(`O:${USER_SID}D:(A;;${rights};;;AU)`, USER_SID).othersMayWrite).toBe(true);
  });
});
