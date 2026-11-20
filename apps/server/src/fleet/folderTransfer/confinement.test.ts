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
    readonly childrenOpen: boolean;
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

describe("macOS listings it cannot read", () => {
  it("an ACL marked on the folder with no entry it understands is unreadable", async () => {
    const { darwinListingReadable } = (await readers()) as unknown as {
      darwinListingReadable: (listing: string) => boolean;
    };
    expect(darwinListingReadable("drwx------  5 sam  staff  160 Jan  1 10:00 /folder\n")).toBe(
      true,
    );
    expect(darwinListingReadable(`${HEAD} 0: group:everyone deny delete\n`)).toBe(true);
    expect(darwinListingReadable(HEAD)).toBe(false);
    expect(darwinListingReadable(`${HEAD} 0: something new\n`)).toBe(false);
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
    ).toEqual({
      owner: "user",
      othersMayWrite: false,
      othersMayReplace: false,
      childrenOpen: false,
    });
    expect(windowsAccess("O:BAG:SYD:(A;;FA;;;SY)", USER_SID).owner).toBe("trusted");
  });

  it("a missing DACL lets everyone write, and is refused", async () => {
    const { windowsAccess } = await readers();
    const open = {
      owner: "user",
      othersMayWrite: true,
      othersMayReplace: true,
      childrenOpen: true,
    };
    expect(windowsAccess(`O:${USER_SID}G:DUD:NO_ACCESS_CONTROL`, USER_SID)).toEqual(open);
    expect(windowsAccess(`O:${USER_SID}G:DU`, USER_SID)).toEqual(open);
    expect(windowsAccess(`O:${USER_SID}G:DUS:(AU;SA;FA;;;WD)`, USER_SID)).toEqual(open);
  });

  it("an empty DACL grants nobody anything", async () => {
    const { windowsAccess } = await readers();
    const shut = {
      owner: "user",
      othersMayWrite: false,
      othersMayReplace: false,
      childrenOpen: false,
    };
    expect(windowsAccess(`O:${USER_SID}G:DUD:`, USER_SID)).toEqual(shut);
    expect(windowsAccess(`O:${USER_SID}G:DUD:PAI`, USER_SID)).toEqual(shut);
    expect(windowsAccess(`O:${USER_SID}G:DUD:PS:(AU;SA;FA;;;WD)`, USER_SID)).toEqual(shut);
  });

  it("an audit entry that names a right is not a grant", async () => {
    const { windowsAccess } = await readers();
    expect(
      windowsAccess(`O:${USER_SID}G:DUD:(A;;FA;;;SY)S:(AU;SA;FA;;;WD)`, USER_SID).othersMayWrite,
    ).toBe(false);
  });

  it("a descriptor it cannot read is treated as open", async () => {
    const { windowsAccess } = await readers();
    expect(windowsAccess("not a descriptor", USER_SID)).toEqual({
      owner: "other",
      othersMayWrite: true,
      othersMayReplace: true,
      childrenOpen: true,
    });
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
      childrenOpen: false,
    });
  });

  it("a grant only new entries inherit opens what is made there", async () => {
    const { windowsAccess } = await readers();
    const read = (sddl: string) =>
      (windowsAccess(sddl, USER_SID) as unknown as { childrenOpen?: boolean }).childrenOpen;
    expect(read(`O:${USER_SID}D:(A;OICIIO;GA;;;${OTHER_SID})`)).toBe(true);
    expect(read(`O:${USER_SID}D:(A;CIIO;FW;;;BU)`)).toBe(true);
    expect(read(`O:${USER_SID}D:(A;OICI;FA;;;AU)`)).toBe(true);
    // Creator owner is whoever makes the entry: the app's user. Read rights open nothing.
    expect(read(`O:${USER_SID}D:(A;OICIIO;GA;;;CO)(A;OICIIO;FR;;;BU)(A;OICI;FA;;;SY)`)).toBe(false);
  });

  it("the alias LA is the user only when Windows resolves it to the user's own SID", async () => {
    const windowsAccess = (await readers()).windowsAccess as unknown as (
      sddl: string,
      userSid: string,
      elevated?: boolean,
      localAdministrator?: string | null,
    ) => ReturnType<Readers["windowsAccess"]>;
    const builtIn = "S-1-5-21-1111111111-2222222222-3333333333-500";
    const sddl = "O:LAG:DUD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;LA)";
    const open = {
      owner: "other",
      othersMayWrite: true,
      othersMayReplace: true,
      childrenOpen: true,
    };
    // A SID that merely ends in -500 is not this machine's administrator.
    expect(windowsAccess(sddl, builtIn)).toEqual(open);
    expect(windowsAccess(sddl, builtIn, false, OTHER_SID)).toEqual(open);
    expect(windowsAccess(sddl, builtIn, false, builtIn)).toEqual({
      owner: "user",
      othersMayWrite: false,
      othersMayReplace: false,
      childrenOpen: false,
    });
  });

  it("an elevated owner is still refused for another principal's grant", async () => {
    const windowsAccess = (await readers()).windowsAccess as unknown as (
      sddl: string,
      userSid: string,
      elevated?: boolean,
    ) => ReturnType<Readers["windowsAccess"]>;
    expect(
      windowsAccess(`O:BAD:(A;OICI;FA;;;BA)(A;;FW;;;${OTHER_SID})`, USER_SID, true),
    ).toMatchObject({ owner: "user", othersMayWrite: true });
  });

  it.each(["KA", "CC", "ZZ"])(
    "an unknown or unlisted right code %s counts as full access",
    async (code) => {
      const { windowsAccess } = await readers();
      expect(windowsAccess(`O:${USER_SID}D:(A;;${code};;;${OTHER_SID})`, USER_SID)).toEqual({
        owner: "user",
        othersMayWrite: true,
        othersMayReplace: true,
        childrenOpen: false,
      });
    },
  );

  it("read codes it knows grant nothing", async () => {
    const { windowsAccess } = await readers();
    for (const code of ["FR", "FX", "GR", "GX", "RC", "GRGX"])
      expect(windowsAccess(`O:${USER_SID}D:(A;OICI;${code};;;BU)`, USER_SID).othersMayWrite).toBe(
        false,
      );
  });

  it("what an elevated administrator makes is owned by Administrators, and is that user's", async () => {
    const windowsAccess = (await readers()).windowsAccess as unknown as (
      sddl: string,
      userSid: string,
      elevated?: boolean,
    ) => { readonly owner: string };
    const sddl = `O:BAG:DUD:(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;${USER_SID})`;
    expect(windowsAccess(sddl, USER_SID, true).owner).toBe("user");
    expect(windowsAccess(sddl, USER_SID, false).owner).toBe("trusted");
    expect(windowsAccess(sddl, USER_SID).owner).toBe("trusted");
    // SYSTEM is never the user, and neither is another account.
    expect(windowsAccess("O:SYD:(A;;FA;;;SY)", USER_SID, true).owner).toBe("trusted");
    expect(windowsAccess(`O:${OTHER_SID}D:(A;;FA;;;SY)`, USER_SID, true).owner).toBe("other");
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
