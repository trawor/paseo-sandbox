import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import { isAbsolute, join, posix } from "node:path";
import { z } from "zod";
import type { ImageRecipe, ImageRequest } from "./provider";

/** The optional project config, read from the default branch before the sandbox exists. */
export const PROJECT_CONFIG_PATH = ".paseo/sandbox.json";
/** The project Dockerfile picked up by convention when no config names another. */
export const PROJECT_DOCKERFILE_PATH = ".paseo.Dockerfile";

/** Variables the plugin itself sets, or that would carry a credential. */
const RESERVED_NAMES = new Set(["PASEO_PASSWORD", "PASEO_HOME", "GITHUB_TOKEN", "BASE_IMAGE"]);
const SECRET_LIKE = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|CREDENTIAL)/i;

function variableProblem(name: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return "must be a plain variable name";
  if (RESERVED_NAMES.has(name)) return "is set by the plugin";
  if (SECRET_LIKE.test(name))
    return "looks like a secret; save credentials in Sandbox settings instead, they reach the sandbox at run time only";
  return null;
}

/** Non-secret variables. Names are checked one by one so each error names its key. */
const variables = z
  .record(z.string(), z.string().max(4096))
  .superRefine((values, context) => {
    for (const name of Object.keys(values)) {
      const problem = variableProblem(name);
      if (problem) context.addIssue({ code: "custom", path: [name], message: problem });
    }
  })
  .default({});

/** A repository-relative path that stays inside the repository and is safe as a sparse pattern. */
const repoPath = z
  .string()
  .min(1)
  .regex(/^[\w./@+-]+$/, "may only contain letters, digits and . / _ @ + -")
  .refine((path) => !isAbsolute(path), "must be relative to the repository root")
  .transform((path) => posix.normalize(path).replace(/\/+$/, "") || ".")
  .refine((path) => path !== ".." && !path.startsWith("../"), "must stay inside the repository");

export const projectConfigSchema = z
  .object({
    $schema: z.string().optional(),
    /** Repository path of the Dockerfile. Defaults to `.paseo.Dockerfile`. */
    dockerfile: repoPath.optional(),
    /** Repository folder sent as the build context. No context (stdin build) when absent. */
    context: repoPath.optional(),
    /** Non-secret build arguments. */
    buildArgs: variables,
    /** Non-secret variables for the sandbox daemon. Saved credentials win over them. */
    env: variables,
    /** A prebuilt image to run instead of building one. Excludes `dockerfile` and `context`. */
    image: z.string().min(1).max(256).optional(),
    /**
     * `builtin` builds the built-in runtime first and passes it as `BASE_IMAGE`; `none` builds the
     * Dockerfile alone. Default: `builtin` when the Dockerfile mentions BASE_IMAGE.
     */
    extends: z.enum(["builtin", "none"]).optional(),
  })
  .strict()
  .refine((config) => !(config.image && (config.dockerfile || config.context)), {
    message: "`image` cannot be combined with `dockerfile` or `context`",
  });
export type ProjectConfig = z.infer<typeof projectConfigSchema>;

const absolutePath = z.string().refine(isAbsolute, "must be an absolute path on the Paseo host");

/** Host-wide image settings: `$PASEO_HOME/plugin-data/sandbox/config.json`, then environment. */
export const pluginImageConfigSchema = z
  .object({
    /** `auto` reads `.paseo/sandbox.json` and `.paseo.Dockerfile` from each project. */
    projectDockerfile: z.enum(["auto", "off"]).default("auto"),
    /** Used for projects without their own image. */
    defaultDockerfile: absolutePath.nullable().default(null),
    defaultContext: absolutePath.nullable().default(null),
    defaultImage: z.string().min(1).nullable().default(null),
    defaultBuildArgs: variables,
  })
  .strict();
export type PluginImageConfig = z.infer<typeof pluginImageConfigSchema>;

function isMissingFile(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function describeIssues(error: z.ZodError) {
  return error.issues
    .map((issue) => `${issue.path.length ? issue.path.join(".") : "(root)"} ${issue.message}`)
    .join("; ");
}

/** Parses project config text, with the file name and every problem in the message. */
export function parseProjectConfig(text: string): ProjectConfig {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${PROJECT_CONFIG_PATH} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = projectConfigSchema.safeParse(json);
  if (!parsed.success)
    throw new Error(`${PROJECT_CONFIG_PATH} is invalid: ${describeIssues(parsed.error)}`);
  return parsed.data;
}

const ENV_OVERRIDES = {
  PASEO_SANDBOX_PROJECT_DOCKERFILE: "projectDockerfile",
  PASEO_SANDBOX_DEFAULT_DOCKERFILE: "defaultDockerfile",
  PASEO_SANDBOX_DEFAULT_CONTEXT: "defaultContext",
  PASEO_SANDBOX_DEFAULT_IMAGE: "defaultImage",
} as const;

/** Reads the host-wide settings. A missing file is the defaults; environment variables win. */
export async function loadPluginImageConfig(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PluginImageConfig> {
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (!isMissingFile(error))
      throw new Error(
        `Sandbox image settings at ${path} are unreadable: ${error instanceof Error ? error.message : String(error)}`,
      );
  }
  for (const [variable, key] of Object.entries(ENV_OVERRIDES)) {
    const value = env[variable]?.trim();
    if (value) raw = { ...raw, [key]: value };
  }
  const parsed = pluginImageConfigSchema.safeParse(raw);
  if (!parsed.success)
    throw new Error(`Sandbox image settings are invalid: ${describeIssues(parsed.error)}`);
  return parsed.data;
}

/** The project's files on the Paseo host, fetched sparsely from its default branch. */
export interface ProjectCheckout {
  /** Folder holding the fetched files at their repository paths. */
  readonly dir: string;
  /** Short commit the files come from, for phase text. */
  readonly commit: string;
  /** Fetches more repository paths (`.` for everything) into `dir`. */
  include(paths: readonly string[]): Promise<void>;
  /** Drops the git metadata, leaving plain files that can serve as a build context. */
  seal(): Promise<void>;
  dispose(): Promise<void>;
}

export interface ResolvedImage {
  request: ImageRequest;
  /** Variables from the project config, applied under the saved credentials. */
  env: Record<string, string>;
  /** Removes fetched files. Call after the image is built. */
  dispose(): Promise<void>;
}

async function readPlainFile(dir: string, path: string) {
  const full = join(dir, path);
  try {
    // A repository symlink must not make the host read a file outside the checkout.
    const info = await lstat(full);
    if (info.isSymbolicLink()) throw new Error(`${path} is a symbolic link, which is not allowed`);
    if (!info.isFile()) throw new Error(`${path} is not a file`);
    return await readFile(full, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

/** Digest of a folder's file names, modes, symlink targets and contents, independent of order. */
export async function digestFolder(root: string): Promise<string> {
  const hash = createHash("sha256");
  async function walk(relative: string) {
    const entries = await readdir(join(root, relative), { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      const full = join(root, path);
      const info = await lstat(full);
      if (info.isSymbolicLink()) hash.update(`l\0${path}\0${await readlink(full)}\0`);
      else if (info.isDirectory()) {
        hash.update(`d\0${path}\0`);
        await walk(path);
      } else if (info.isFile()) {
        hash.update(`f\0${path}\0${info.mode & 0o111 ? "x" : "-"}\0`);
        hash.update(await readFile(full));
        hash.update("\0");
      }
    }
  }
  await walk("");
  return hash.digest("hex");
}

function extendsBuiltin(dockerfile: string, choice: ProjectConfig["extends"]) {
  if (choice) return choice === "builtin";
  return /\$\{?BASE_IMAGE\b/.test(dockerfile);
}

async function dockerfileRecipe(
  dockerfile: string,
  context: string | null,
  buildArgs: Record<string, string>,
  choice: ProjectConfig["extends"],
): Promise<ImageRecipe> {
  return {
    kind: "dockerfile",
    dockerfile,
    context,
    buildArgs,
    extendsBuiltin: extendsBuiltin(dockerfile, choice),
    contextDigest: context ? await digestFolder(context) : "",
  };
}

const noop = async () => undefined;

export interface ResolveOptions {
  config: PluginImageConfig;
  /** Fetches `.paseo/sandbox.json` and `.paseo.Dockerfile`; only called when the switch is on. */
  openProject: () => Promise<ProjectCheckout>;
  rebuild?: boolean;
  /** Reads a host file; injectable for tests. */
  readHostFile?: (path: string) => Promise<string>;
}

/**
 * Picks the sandbox image. First hit wins: the project's `.paseo/sandbox.json`, the project's
 * `.paseo.Dockerfile`, the host-wide default, the built-in runtime.
 */
export async function resolveImage(options: ResolveOptions): Promise<ResolvedImage> {
  const { config, rebuild } = options;
  const readHostFile = options.readHostFile ?? ((path: string) => readFile(path, "utf8"));
  let env: Record<string, string> = {};

  if (config.projectDockerfile === "auto") {
    const checkout = await options.openProject();
    try {
      const at = checkout.commit ? ` at ${checkout.commit}` : "";
      const configText = await readPlainFile(checkout.dir, PROJECT_CONFIG_PATH);
      const project = configText === null ? null : parseProjectConfig(configText);
      env = project?.env ?? {};
      if (project?.image) {
        await checkout.dispose();
        return {
          request: {
            recipe: { kind: "image", image: project.image },
            source: `the project's ${PROJECT_CONFIG_PATH}${at}`,
            rebuild,
          },
          env,
          dispose: noop,
        };
      }
      const dockerfilePath = project?.dockerfile ?? PROJECT_DOCKERFILE_PATH;
      const context = project?.context ?? null;
      const extra = [dockerfilePath, ...(context ? [context === "." ? "." : `${context}/`] : [])];
      if (dockerfilePath !== PROJECT_DOCKERFILE_PATH || context) await checkout.include(extra);
      const dockerfile = await readPlainFile(checkout.dir, dockerfilePath);
      if (dockerfile === null && project?.dockerfile)
        throw new Error(
          `${PROJECT_CONFIG_PATH} names ${project.dockerfile}, which is not in the project's default branch.`,
        );
      if (dockerfile !== null) {
        await checkout.seal();
        const contextDir = context ? join(checkout.dir, context) : null;
        if (contextDir) {
          const info = await lstat(contextDir).catch(() => null);
          if (!info?.isDirectory())
            throw new Error(
              `${PROJECT_CONFIG_PATH} names context ${context}, which is not a folder.`,
            );
        }
        const source = project
          ? `the project's ${dockerfilePath} (via ${PROJECT_CONFIG_PATH})${at}`
          : `the project's ${PROJECT_DOCKERFILE_PATH}${at}`;
        return {
          request: {
            recipe: await dockerfileRecipe(
              dockerfile,
              contextDir,
              project?.buildArgs ?? {},
              project?.extends,
            ),
            source,
            rebuild,
          },
          env,
          dispose: () => checkout.dispose(),
        };
      }
      await checkout.dispose();
    } catch (error) {
      await checkout.dispose();
      throw error;
    }
  }

  if (config.defaultImage)
    return {
      request: {
        recipe: { kind: "image", image: config.defaultImage },
        source: "the host's default image setting",
        rebuild,
      },
      env,
      dispose: noop,
    };
  if (config.defaultDockerfile) {
    const dockerfile = await readHostFile(config.defaultDockerfile);
    return {
      request: {
        recipe: await dockerfileRecipe(
          dockerfile,
          config.defaultContext,
          config.defaultBuildArgs,
          undefined,
        ),
        source: `the host's default Dockerfile ${config.defaultDockerfile}`,
        rebuild,
      },
      env,
      dispose: noop,
    };
  }
  return {
    request: { recipe: { kind: "builtin" }, source: "the built-in runtime", rebuild },
    env,
    dispose: noop,
  };
}
