import { assert, it } from "@effect/vitest";
import * as NodePath from "node:path";
import { exposesProtectedLocation } from "./ProjectEnvironmentPaths.ts";

const path = NodePath.posix;
const home = "/Users/person";

it("refuses root, home, its ancestors and credential folders as approved project folders", () => {
  for (const folder of [
    "/",
    "/Users",
    home,
    `${home}/.ssh`,
    `${home}/.ssh/keys`,
    `${home}/.aws`,
    `${home}/.config/gh`,
    `${home}/.codex/sessions`,
    `${home}/Library/Keychains`,
  ])
    assert.isTrue(exposesProtectedLocation(folder, home, path), folder);
});

it("accepts ordinary project and data folders", () => {
  for (const folder of [
    `${home}/Projects/app`,
    `${home}/.config/app-settings`,
    `${home}/Documents/contracts`,
    "/srv/data",
  ])
    assert.isFalse(exposesProtectedLocation(folder, home, path), folder);
});
