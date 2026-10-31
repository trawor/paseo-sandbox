import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { openProjectCheckout } from "../server/project-files";
import {
  loadPluginImageConfig,
  type PluginImageConfig,
  type ProjectCheckout,
  parseProjectConfig,
  pluginImageConfigSchema,
  resolveImage,
} from "../server/project-image";
import { parseRepository } from "../server/repository";

const AUTO: PluginImageConfig = pluginImageConfigSchema.parse({});
const EXTENDING = `ARG BASE_IMAGE\nFROM \${BASE_IMAGE}\nRUN apt-get install -y gh\n`;

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "sandbox-image-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function files(entries: Record<string, string>) {
  for (const [path, text] of Object.entries(entries)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
}

/** The project's files already on disk, with the calls the resolver made. */
function checkout() {
  const calls = { opened: 0, included: [] as string[][], sealed: false, disposed: 0 };
  const open = async (): Promise<ProjectCheckout> => {
    calls.opened++;
    return {
      dir: root,
      commit: "abc123",
      async include(paths) {
        calls.included.push([...paths]);
      },
      async seal() {
        calls.sealed = true;
      },
      async dispose() {
        calls.disposed++;
      },
    };
  };
  return { calls, open };
}

describe("project config", () => {
  test("defaults every optional field", () => {
    expect(parseProjectConfig("{}")).toEqual({ buildArgs: {}, env: {} });
    expect(parseProjectConfig('{"context": "docker/./"}').context).toBe("docker");
  });

  test("invalid JSON names the file", () => {
    expect(() => parseProjectConfig("{ dockerfile: x")).toThrow(
      /^\.paseo\/sandbox\.json is not valid JSON/,
    );
  });

  test("each invalid field is named", () => {
    const parse = (value: unknown) => () => parseProjectConfig(JSON.stringify(value));
    expect(parse({ dockerfle: "x" })).toThrow(/invalid: .*dockerfle/);
    expect(parse({ dockerfile: "../outside" })).toThrow("dockerfile must stay inside");
    expect(parse({ dockerfile: "/etc/passwd" })).toThrow("dockerfile must be relative");
    expect(parse({ context: "a b" })).toThrow("context may only contain");
    expect(parse({ extends: "ubuntu" })).toThrow("extends");
    expect(parse({ image: "x:1", dockerfile: "D" })).toThrow("cannot be combined");
    expect(parse({ env: { GITHUB_TOKEN: "x" } })).toThrow("env.GITHUB_TOKEN is set by the plugin");
    expect(parse({ buildArgs: { NPM_TOKEN: "x" } })).toThrow(
      "buildArgs.NPM_TOKEN looks like a secret",
    );
    expect(parse({ env: { "BAD-NAME": "x" } })).toThrow("plain variable name");
  });
});

describe("host-wide image settings", () => {
  test("a missing file is auto with no defaults, and the environment wins", async () => {
    const path = join(root, "config.json");
    expect(await loadPluginImageConfig(path, {})).toEqual(AUTO);
    await writeFile(path, JSON.stringify({ defaultImage: "acme/rt:1" }));
    const config = await loadPluginImageConfig(path, { PASEO_SANDBOX_PROJECT_DOCKERFILE: "off" });
    expect(config).toMatchObject({ projectDockerfile: "off", defaultImage: "acme/rt:1" });
  });

  test("bad settings are refused rather than ignored", async () => {
    const path = join(root, "config.json");
    await expect(
      loadPluginImageConfig(path, { PASEO_SANDBOX_PROJECT_DOCKERFILE: "maybe" }),
    ).rejects.toThrow("projectDockerfile");
    await expect(
      loadPluginImageConfig(path, { PASEO_SANDBOX_DEFAULT_DOCKERFILE: "relative/Dockerfile" }),
    ).rejects.toThrow("absolute path");
    await writeFile(path, "{");
    await expect(loadPluginImageConfig(path, {})).rejects.toThrow("unreadable");
  });
});

describe("resolution order", () => {
  test(".paseo/sandbox.json wins over .paseo.Dockerfile and fetches what it names", async () => {
    await files({
      ".paseo/sandbox.json": JSON.stringify({
        dockerfile: "docker/sandbox.Dockerfile",
        context: "docker",
        buildArgs: { PYTHON: "3.12" },
        env: { PIP_INDEX_URL: "https://pypi.example/simple" },
      }),
      ".paseo.Dockerfile": "FROM ignored\n",
      "docker/sandbox.Dockerfile": EXTENDING,
      "docker/requirements.txt": "ruff\n",
    });
    const { calls, open } = checkout();
    const resolved = await resolveImage({ config: AUTO, openProject: open });

    expect(calls.included).toEqual([["docker/sandbox.Dockerfile", "docker/"]]);
    expect(calls.sealed).toBe(true);
    expect(resolved.env).toEqual({ PIP_INDEX_URL: "https://pypi.example/simple" });
    expect(resolved.request.source).toBe(
      "the project's docker/sandbox.Dockerfile (via .paseo/sandbox.json) at abc123",
    );
    expect(resolved.request.recipe).toMatchObject({
      kind: "dockerfile",
      dockerfile: EXTENDING,
      context: join(root, "docker"),
      buildArgs: { PYTHON: "3.12" },
      extendsBuiltin: true,
    });
    await resolved.dispose();
    expect(calls.disposed).toBe(1);
  });

  test("a bare .paseo.Dockerfile is used by convention, without a context", async () => {
    await files({ ".paseo.Dockerfile": EXTENDING });
    const { calls, open } = checkout();
    const resolved = await resolveImage({ config: AUTO, openProject: open });
    expect(calls.included).toEqual([]);
    expect(resolved.request.source).toBe("the project's .paseo.Dockerfile at abc123");
    expect(resolved.request.recipe).toMatchObject({
      kind: "dockerfile",
      context: null,
      contextDigest: "",
      extendsBuiltin: true,
    });
  });

  test("a Dockerfile without BASE_IMAGE stands alone unless told otherwise", async () => {
    await files({ ".paseo.Dockerfile": "FROM acme/paseo:1\n" });
    const alone = await resolveImage({ config: AUTO, openProject: checkout().open });
    expect(alone.request.recipe).toMatchObject({ extendsBuiltin: false });
    await files({ ".paseo/sandbox.json": '{"extends": "builtin"}' });
    const forced = await resolveImage({ config: AUTO, openProject: checkout().open });
    expect(forced.request.recipe).toMatchObject({ extendsBuiltin: true });
  });

  test("a config naming a prebuilt image skips building", async () => {
    await files({
      ".paseo/sandbox.json": '{"image": "ghcr.io/acme/rt:2"}',
      ".paseo.Dockerfile": EXTENDING,
    });
    const resolved = await resolveImage({ config: AUTO, openProject: checkout().open });
    expect(resolved.request.recipe).toEqual({ kind: "image", image: "ghcr.io/acme/rt:2" });
  });

  test("a config without a Dockerfile keeps its env and falls through to the defaults", async () => {
    await files({ ".paseo/sandbox.json": '{"env": {"RUST_LOG": "info"}}' });
    const resolved = await resolveImage({ config: AUTO, openProject: checkout().open });
    expect(resolved.request.recipe).toEqual({ kind: "builtin" });
    expect(resolved.env).toEqual({ RUST_LOG: "info" });
  });

  test("a config naming a missing Dockerfile or context is an error", async () => {
    await files({ ".paseo/sandbox.json": '{"dockerfile": "nope.Dockerfile"}' });
    await expect(resolveImage({ config: AUTO, openProject: checkout().open })).rejects.toThrow(
      "names nope.Dockerfile, which is not in the project's default branch",
    );
    await files({
      ".paseo/sandbox.json": '{"context": "missing"}',
      ".paseo.Dockerfile": EXTENDING,
    });
    const { calls, open } = checkout();
    await expect(resolveImage({ config: AUTO, openProject: open })).rejects.toThrow(
      "context missing, which is not a folder",
    );
    expect(calls.disposed).toBeGreaterThan(0);
  });

  test("invalid project JSON stops the start with the reason", async () => {
    await files({ ".paseo/sandbox.json": "{,}" });
    await expect(resolveImage({ config: AUTO, openProject: checkout().open })).rejects.toThrow(
      "not valid JSON",
    );
  });

  test("a symlinked Dockerfile is refused, so the host never reads outside the checkout", async () => {
    await symlink("/etc/passwd", join(root, ".paseo.Dockerfile"));
    await expect(resolveImage({ config: AUTO, openProject: checkout().open })).rejects.toThrow(
      "symbolic link",
    );
  });

  test("without project files the host default is used, then the built-in image", async () => {
    const empty = await resolveImage({ config: AUTO, openProject: checkout().open });
    expect(empty.request.recipe).toEqual({ kind: "builtin" });

    const withImage = await resolveImage({
      config: { ...AUTO, defaultImage: "acme/rt:1" },
      openProject: checkout().open,
    });
    expect(withImage.request).toMatchObject({
      recipe: { kind: "image", image: "acme/rt:1" },
      source: "the host's default image setting",
    });

    const withDockerfile = await resolveImage({
      config: { ...AUTO, defaultDockerfile: "/srv/paseo/Dockerfile", defaultBuildArgs: { A: "1" } },
      openProject: checkout().open,
      readHostFile: async () => EXTENDING,
    });
    expect(withDockerfile.request.recipe).toMatchObject({
      kind: "dockerfile",
      buildArgs: { A: "1" },
      extendsBuiltin: true,
    });
    expect(withDockerfile.request.source).toBe(
      "the host's default Dockerfile /srv/paseo/Dockerfile",
    );
  });

  test("the off switch never fetches the project", async () => {
    await files({ ".paseo.Dockerfile": EXTENDING });
    const { calls, open } = checkout();
    const resolved = await resolveImage({
      config: { ...AUTO, projectDockerfile: "off" },
      openProject: open,
      rebuild: true,
    });
    expect(calls.opened).toBe(0);
    expect(resolved.request).toEqual({
      recipe: { kind: "builtin" },
      source: "the built-in runtime",
      rebuild: true,
    });
  });

  test("an edited context file changes the recipe digest", async () => {
    await files({
      ".paseo/sandbox.json": '{"context": "."}',
      ".paseo.Dockerfile": EXTENDING,
      "tool.sh": "echo 1\n",
    });
    const first = await resolveImage({ config: AUTO, openProject: checkout().open });
    await files({ "tool.sh": "echo 2\n" });
    const second = await resolveImage({ config: AUTO, openProject: checkout().open });
    const digest = (r: typeof first) =>
      r.request.recipe.kind === "dockerfile" ? r.request.recipe.contextDigest : "";
    expect(digest(first)).toMatch(/^[0-9a-f]{64}$/);
    expect(digest(second)).not.toBe(digest(first));
  });
});

describe("fetching project files on the host", () => {
  function git(cwd: string, ...args: string[]) {
    return execFileSync("git", args, { cwd, encoding: "utf8" });
  }

  test("only the image files are downloaded until more are asked for", async () => {
    const source = join(root, "src");
    await mkdir(join(source, ".paseo"), { recursive: true });
    await mkdir(join(source, "docker"), { recursive: true });
    await writeFile(join(source, ".paseo.Dockerfile"), EXTENDING);
    await writeFile(join(source, ".paseo", "sandbox.json"), "{}");
    await writeFile(join(source, "docker", "x.txt"), "x");
    await writeFile(join(source, "big.bin"), "big");
    git(root, "init", "-q", "-b", "main", source);
    git(source, "add", "-A");
    git(source, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
    git(root, "clone", "-q", "--bare", source, join(root, "bare.git"));
    git(join(root, "bare.git"), "config", "uploadpack.allowFilter", "true");

    const fetched = await openProjectCheckout(`file://${join(root, "bare.git")}`);
    try {
      expect(fetched.commit).toMatch(/^[0-9a-f]{12}$/);
      expect(existsSync(join(fetched.dir, ".paseo.Dockerfile"))).toBe(true);
      expect(existsSync(join(fetched.dir, ".paseo", "sandbox.json"))).toBe(true);
      expect(existsSync(join(fetched.dir, "big.bin"))).toBe(false);
      await fetched.include(["docker/"]);
      expect(existsSync(join(fetched.dir, "docker", "x.txt"))).toBe(true);
      await fetched.seal();
      expect(existsSync(join(fetched.dir, ".git"))).toBe(false);
    } finally {
      await fetched.dispose();
    }
    expect(existsSync(fetched.dir)).toBe(false);
  });

  test("an unreachable project explains how to fix or skip it", async () => {
    await expect(openProjectCheckout(`file://${join(root, "missing.git")}`)).rejects.toThrow(
      "PASEO_SANDBOX_PROJECT_DOCKERFILE=off",
    );
  });
});

describe("local test repositories", () => {
  test("plain http is refused unless the test-only flag is set", () => {
    expect(() => parseRepository("http://172.17.0.1:8080/demo.git", {})).toThrow("https");
    expect(
      parseRepository("http://172.17.0.1:8080/demo.git", {
        PASEO_SANDBOX_ALLOW_INSECURE_REPOS: "1",
      }).directory,
    ).toBe("demo");
  });
});
