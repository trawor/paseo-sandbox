import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, posix, resolve } from "node:path";
import { z } from "zod";
import type { HostMount } from "./provider";

export const MAX_MOUNTS = 16;
/** The sandbox user's home is its own volume; nothing may be mounted over, under or above it. */
export const SANDBOX_HOME = "/home/paseo";
/** Where a local project folder is mounted unless a target is given. */
export const LOCAL_PROJECT_ROOT = "/workspace";

/** The container's own system folders: a mount at or under them would break the runtime. */
const SYSTEM_TREES = [
  "/proc",
  "/sys",
  "/dev",
  "/etc",
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib64",
  "/run",
  "/boot",
];
/** Folders that may hold mounts below them but must not be replaced as a whole. */
const SYSTEM_ROOTS = [
  "/",
  "/var",
  "/tmp",
  "/opt",
  "/srv",
  "/mnt",
  "/media",
  "/home",
  "/root",
  LOCAL_PROJECT_ROOT,
];

function within(path: string, root: string) {
  return path === root || path.startsWith(`${root}/`);
}

/** Why `target` cannot be a mount point inside the sandbox, or null when it can. */
export function targetProblem(target: string): string | null {
  if (!target.startsWith("/")) return "must be an absolute path inside the sandbox";
  if (/[,"\n]/.test(target)) return "may not contain a comma, quote or newline";
  if (
    target.split("/").includes("..") ||
    posix.normalize(target) !== target ||
    (target.endsWith("/") && target !== "/")
  )
    return "must be a normalized path without `..`, `.`, `//` or a trailing slash";
  if (within(target, SANDBOX_HOME) || within(SANDBOX_HOME, target))
    return `may not be at, under or above ${SANDBOX_HOME}, the sandbox's own volume`;
  if (SYSTEM_TREES.some((root) => within(target, root)) || SYSTEM_ROOTS.includes(target))
    return "would replace a system folder of the sandbox";
  return null;
}

/** Why `source` cannot be a host path, before `~` is expanded, or null when it can. */
export function sourceProblem(source: string): string | null {
  if (/[,"\n]/.test(source)) return "may not contain a comma, quote or newline";
  if (source !== "~" && !source.startsWith("~/") && !isAbsolute(source))
    return "must be an absolute path or start with ~/ on the Paseo host";
  return null;
}

export function expandHome(path: string, home = homedir()) {
  if (path === "~") return home;
  if (path.startsWith("~/")) return `${home}${path.slice(1)}`;
  return path;
}

export const mountSchema = z
  .object({
    /** Host folder or file: absolute, or `~/` for the daemon user's home. */
    source: z.string().min(1).max(1024),
    /** Absolute path inside the sandbox. */
    target: z.string().min(1).max(1024),
    /** Read-only unless set to false. */
    readOnly: z.boolean().default(true),
  })
  .strict()
  .superRefine((mount, context) => {
    const source = sourceProblem(mount.source);
    if (source) context.addIssue({ code: "custom", path: ["source"], message: source });
    const target = targetProblem(mount.target);
    if (target) context.addIssue({ code: "custom", path: ["target"], message: target });
  });
export type MountConfig = z.infer<typeof mountSchema>;

export const mountsSchema = z
  .array(mountSchema)
  .max(MAX_MOUNTS)
  .superRefine((mounts, context) => {
    const seen = new Set<string>();
    mounts.forEach((mount, index) => {
      if (seen.has(mount.target))
        context.addIssue({
          code: "custom",
          path: [index, "target"],
          message: `${mount.target} is mounted twice`,
        });
      seen.add(mount.target);
    });
  })
  .default([]);

export interface LabeledMount extends MountConfig {
  /** Where the mount was configured, for error messages, e.g. `.paseo/sandbox.json mounts[0]`. */
  origin: string;
}

/**
 * Expands `~`, requires each source to exist on this host, and refuses a target configured twice,
 * naming the config entries involved. Earlier entries keep their place; a later duplicate fails.
 */
export async function resolveMounts(
  mounts: readonly LabeledMount[],
  taken: ReadonlyMap<string, string> = new Map(),
  home = homedir(),
): Promise<HostMount[]> {
  const owners = new Map(taken);
  const resolved: HostMount[] = [];
  for (const mount of mounts) {
    const owner = owners.get(mount.target);
    if (owner)
      throw new Error(
        `${mount.origin}.target ${mount.target} is already mounted by ${owner}. Use another target.`,
      );
    owners.set(mount.target, mount.origin);
    const source = resolve(expandHome(mount.source, home));
    try {
      await stat(source);
    } catch {
      throw new Error(
        `${mount.origin}.source ${mount.source} does not exist on the Paseo host. Create it or remove the mount.`,
      );
    }
    resolved.push({
      source: await realpath(source),
      target: mount.target,
      readOnly: mount.readOnly,
    });
  }
  return resolved;
}

/** The sandbox path for a local folder: `/workspace/<folder name>`, made safe. */
export function defaultLocalTarget(folder: string) {
  const name =
    posix
      .basename(folder)
      .replace(/[^\w.-]/g, "-")
      .replace(/^[.-]+/, "") || "project";
  return `${LOCAL_PROJECT_ROOT}/${name}`;
}

export interface LocalProject {
  /** Real absolute path on the Paseo host. */
  path: string;
  /** Absolute path inside the sandbox, opened as the project. */
  target: string;
  /** Default sandbox name. */
  name: string;
}

/**
 * Validates a host folder to run as a sandbox project. Refuses `/`, the daemon user's home and
 * anything above it, and targets that would shadow the sandbox's own volume or system folders.
 */
export async function resolveLocalProject(
  input: string,
  target: string | undefined,
  home = homedir(),
): Promise<LocalProject> {
  const trimmed = input.trim();
  const problem = sourceProblem(trimmed);
  if (problem) throw new Error(`The local folder ${problem}.`);
  const expanded = resolve(expandHome(trimmed, home));
  let path: string;
  try {
    path = await realpath(expanded);
  } catch {
    throw new Error(`The local folder ${expanded} does not exist on the Paseo host.`);
  }
  if (!(await stat(path)).isDirectory()) throw new Error(`${path} is not a folder.`);
  if (/[,"\n]/.test(path))
    throw new Error(
      `${path} contains a comma, quote or newline, which Docker mounts cannot carry.`,
    );
  const realHome = await realpath(home).catch(() => home);
  if (path === "/" || path === realHome || within(realHome, path))
    throw new Error(
      `Refusing to mount ${path}: pick a project folder, not / or a home folder or a folder above it.`,
    );
  const chosen = target?.trim() || defaultLocalTarget(path);
  const targetIssue = targetProblem(chosen);
  if (targetIssue) throw new Error(`The sandbox path ${chosen} ${targetIssue}.`);
  return { path, target: chosen, name: posix.basename(path) };
}
