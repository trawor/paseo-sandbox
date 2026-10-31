import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  defaultLocalTarget,
  type LabeledMount,
  mountsSchema,
  resolveLocalProject,
  resolveMounts,
  targetProblem,
} from "../server/mounts";

let root: string;
let home: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "sandbox-mounts-")));
  home = join(root, "home");
  await mkdir(join(home, "code", "my proj!"), { recursive: true });
  await mkdir(join(home, "data"), { recursive: true });
  await writeFile(join(home, "notes.txt"), "x");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("mount targets", () => {
  test.each([
    ["relative/path", "absolute"],
    ["/data/../etc", "normalized"],
    ["/data/", "normalized"],
    ["/data//x", "normalized"],
    ["/home/paseo", "/home/paseo"],
    ["/home/paseo/.ssh", "/home/paseo"],
    ["/home", "/home/paseo"],
    ["/", "system folder"],
    ["/etc/ssl", "system folder"],
    ["/usr", "system folder"],
    ["/workspace", "system folder"],
    ["/tmp", "system folder"],
    ["/data,readonly", "comma"],
  ])("%s is refused", (target, reason) => {
    expect(targetProblem(target)).toContain(reason);
  });

  test.each(["/data", "/workspace/app", "/tmp/cache", "/opt/sdk", "/mnt/datasets"])(
    "%s is allowed",
    (target) => {
      expect(targetProblem(target)).toBeNull();
    },
  );
});

describe("mount config", () => {
  test("read-only by default, strict, unique targets, at most 16", () => {
    expect(mountsSchema.parse([{ source: "~/data", target: "/data" }])).toEqual([
      { source: "~/data", target: "/data", readOnly: true },
    ]);
    expect(mountsSchema.parse(undefined)).toEqual([]);
    expect(mountsSchema.safeParse([{ source: "/a", target: "/b", rw: true }]).success).toBe(false);
    expect(mountsSchema.safeParse([{ source: "rel", target: "/b" }]).success).toBe(false);
    const twice = mountsSchema.safeParse([
      { source: "/a", target: "/b" },
      { source: "/c", target: "/b" },
    ]);
    expect(twice.error?.issues[0]?.message).toBe("/b is mounted twice");
    const many = Array.from({ length: 17 }, (_, i) => ({ source: "/a", target: `/m${i}` }));
    expect(mountsSchema.safeParse(many).success).toBe(false);
  });
});

describe("resolving mounts on the host", () => {
  const labeled = (mount: Partial<LabeledMount>): LabeledMount => ({
    source: "~/data",
    target: "/data",
    readOnly: true,
    origin: "host config mounts[0]",
    ...mount,
  });

  test("expands ~ and keeps order and read-only flags", async () => {
    const mounts = await resolveMounts(
      [labeled({}), labeled({ source: "~/notes.txt", target: "/notes.txt", readOnly: false })],
      new Map(),
      home,
    );
    expect(mounts).toEqual([
      { source: join(home, "data"), target: "/data", readOnly: true },
      { source: join(home, "notes.txt"), target: "/notes.txt", readOnly: false },
    ]);
  });

  test("a missing source names the config key", async () => {
    await expect(
      resolveMounts(
        [labeled({ source: "~/nope", origin: ".paseo/sandbox.json mounts[2]" })],
        new Map(),
        home,
      ),
    ).rejects.toThrow(
      ".paseo/sandbox.json mounts[2].source ~/nope does not exist on the Paseo host",
    );
  });

  test("a later mount on a taken target fails and names the owner", async () => {
    await expect(
      resolveMounts(
        [labeled({}), labeled({ origin: ".paseo/sandbox.json mounts[0]" })],
        new Map(),
        home,
      ),
    ).rejects.toThrow(
      ".paseo/sandbox.json mounts[0].target /data is already mounted by host config mounts[0]",
    );
    await expect(
      resolveMounts(
        [labeled({ target: "/workspace/app" })],
        new Map([["/workspace/app", "the local project folder"]]),
        home,
      ),
    ).rejects.toThrow("already mounted by the local project folder");
  });
});

describe("local project folders", () => {
  test("a folder resolves to /workspace/<safe name>, with ~ expanded", async () => {
    const project = await resolveLocalProject("~/code/my proj!", undefined, home);
    expect(project).toEqual({
      path: join(home, "code", "my proj!"),
      target: "/workspace/my-proj-",
      name: "my proj!",
    });
    expect(defaultLocalTarget("/x/.hidden")).toBe("/workspace/hidden");
    expect(defaultLocalTarget("/")).toBe("/workspace/project");
  });

  test("a chosen target is checked like any mount target", async () => {
    const folder = join(home, "data");
    expect((await resolveLocalProject(folder, "/srv/app", home)).target).toBe("/srv/app");
    await expect(resolveLocalProject(folder, "/home/paseo/app", home)).rejects.toThrow(
      "/home/paseo",
    );
    await expect(resolveLocalProject(folder, "app", home)).rejects.toThrow("absolute");
  });

  test("missing paths, files, /, the home folder and its parents are refused", async () => {
    await expect(resolveLocalProject("~/missing", undefined, home)).rejects.toThrow(
      "does not exist",
    );
    await expect(resolveLocalProject("~/notes.txt", undefined, home)).rejects.toThrow(
      "is not a folder",
    );
    await expect(resolveLocalProject("/", undefined, home)).rejects.toThrow("Refusing");
    await expect(resolveLocalProject("~", undefined, home)).rejects.toThrow("Refusing");
    await expect(resolveLocalProject(root, undefined, home)).rejects.toThrow("Refusing");
    await expect(resolveLocalProject("code/x", undefined, home)).rejects.toThrow("absolute");
  });
});
