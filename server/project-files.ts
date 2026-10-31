import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROJECT_CONFIG_PATH,
  PROJECT_DOCKERFILE_PATH,
  type ProjectCheckout,
} from "./project-image";

const GIT_TIMEOUT_MS = 5 * 60_000;

export interface FetchOptions {
  /** Sent only to github.com over https, through the environment, never argv. */
  githubToken?: string;
  timeoutMs?: number;
}

function runGit(args: readonly string[], env: NodeJS.ProcessEnv, timeoutMs: number) {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  execFile(
    "git",
    [...args],
    { env, timeout: timeoutMs, maxBuffer: 4 << 20 },
    (error, stdout, stderr) => {
      if (!error) return resolve(stdout);
      if ("code" in error && error.code === "ENOENT")
        return reject(new Error("git is not installed on the Paseo host, or not on its PATH."));
      const detail = stderr.trim().split("\n").at(-1) || error.message;
      reject(new Error(`git ${args[0] === "-C" ? args[2] : args[0]} failed: ${detail}`));
    },
  );
  return promise;
}

function gitEnvironment(url: string, token: string | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    GIT_LFS_SKIP_SMUDGE: "1",
  };
  const parsed = new URL(url);
  if (token && parsed.protocol === "https:" && parsed.hostname === "github.com") {
    const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
    // GIT_CONFIG_* keeps the header out of argv and out of any file.
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = "http.https://github.com/.extraheader";
    env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${basic}`;
  }
  return env;
}

/**
 * Shallow, blobless, sparse clone of the project's default branch into a private temp folder on
 * the Paseo host, so its image config is readable before the sandbox exists. Only the files that
 * are asked for are downloaded.
 */
export async function openProjectCheckout(
  url: string,
  options: FetchOptions = {},
): Promise<ProjectCheckout> {
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
  const env = gitEnvironment(url, options.githubToken);
  const root = await mkdtemp(join(tmpdir(), "paseo-sandbox-project-"));
  const dir = join(root, "repo");
  const git = (...args: string[]) => runGit(["-C", dir, ...args], env, timeoutMs);
  const dispose = () => rm(root, { recursive: true, force: true });
  try {
    await runGit(
      ["clone", "--quiet", "--depth", "1", "--filter=blob:none", "--no-checkout", "--", url, dir],
      env,
      timeoutMs,
    );
    await git(
      "sparse-checkout",
      "set",
      "--no-cone",
      `/${PROJECT_CONFIG_PATH}`,
      `/${PROJECT_DOCKERFILE_PATH}`,
    );
    await git("checkout", "--quiet");
    const commit = (await git("rev-parse", "--short=12", "HEAD")).trim();
    let sealed = false;
    return {
      dir,
      commit,
      async include(paths) {
        if (sealed) throw new Error("The project checkout is sealed.");
        if (paths.includes(".")) await git("sparse-checkout", "disable");
        else await git("sparse-checkout", "add", ...paths.map((path) => `/${path}`));
      },
      async seal() {
        sealed = true;
        await rm(join(dir, ".git"), { recursive: true, force: true });
      },
      dispose,
    };
  } catch (error) {
    await dispose();
    throw new Error(
      `Could not read the project's sandbox image settings from ${url} on the Paseo host. For a private project, save a GitHub token or share the GitHub login in Sandbox settings; to skip project images, set PASEO_SANDBOX_PROJECT_DOCKERFILE=off. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
