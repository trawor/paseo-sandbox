import { beforeEach, describe, expect, test } from "vitest";
import { type DockerCli, DockerError, type DockerOptions } from "../server/docker/cli";
import { IMAGE_TAG } from "../server/docker/image";
import { createDockerProvider } from "../server/docker/provider";
import { imageTag } from "../server/docker/recipe";
import type { ImageRecipe, ImageRequest } from "../server/provider";

interface FakeContainer {
  state: "running" | "exited";
  image: string;
  imageId: string;
  revision: string;
  health: "healthy" | "unhealthy";
}

const HEALTHY_CONTRACT = "missing:\nagents:\n";

interface Call {
  args: readonly string[];
  options: DockerOptions;
}

/** An in-memory Docker: containers, volumes and images, with the answers the CLI would give. */
class FakeDocker {
  images = new Set<string>();
  /** Image ids by tag; a rebuild gives a tag a new id. */
  imageIds = new Map<string, string>();
  /** Tags whose image has no HEALTHCHECK. */
  noHealthcheck = new Set<string>();
  /** What the runtime-contract check prints inside a candidate image. */
  contract = HEALTHY_CONTRACT;
  private builds = 0;
  volumes = new Set<string>();
  containers = new Map<string, FakeContainer>();
  calls: Call[] = [];
  daemonDown = false;
  health: FakeContainer["health"] = "healthy";

  readonly cli: DockerCli = async (args, options = {}) => {
    this.calls.push({ args, options });
    const [group, verb] = args;
    const name = args.at(-1) ?? "";
    if (this.daemonDown)
      throw new DockerError("docker version failed", "Cannot connect to the Docker daemon");
    if (group === "version") return ok("27");
    if (group === "image" && verb === "inspect") {
      this.require(this.images.has(name), "image");
      const format = args[args.indexOf("--format") + 1] ?? "";
      if (format.includes("Healthcheck"))
        return ok(this.noHealthcheck.has(name) ? "null\n" : '{"Test":["CMD","true"]}\n');
      return ok(format.includes(".Id") ? `${this.idOf(name)}\n` : "");
    }
    if (group === "image" && verb === "rm") {
      this.images.delete(name);
      return ok("");
    }
    if (group === "build") {
      const tag = args[args.indexOf("--tag") + 1] ?? "";
      this.images.add(tag);
      this.imageIds.set(tag, `sha256:build${++this.builds}`);
      return ok("");
    }
    if (group === "pull") {
      this.images.add(name);
      this.imageIds.set(name, `sha256:pull${++this.builds}`);
      return ok("");
    }
    if (group === "volume" && verb === "inspect")
      return this.require(this.volumes.has(name), "volume");
    if (group === "volume" && verb === "create") {
      this.volumes.add(name);
      return ok(name);
    }
    if (group === "volume" && verb === "rm") {
      if (!this.volumes.delete(name)) throw missing("volume", name);
      return ok("");
    }
    if (group === "exec") return ok("");
    if (group === "run") return this.run(args, options);
    if (group === "container") return this.container(verb ?? "", args, name);
    throw new Error(`Unhandled docker call: ${args.join(" ")}`);
  };

  idOf(tag: string) {
    return this.imageIds.get(tag) ?? `sha256:${tag}`;
  }

  private require(present: boolean, kind: string) {
    if (!present) throw missing(kind, "x");
    return ok("");
  }

  private run(args: readonly string[], options: DockerOptions) {
    if (args.includes("--rm")) return ok(this.contract);
    const name = args[args.indexOf("--name") + 1] ?? "";
    const label = args.find((arg) => arg.includes("sandbox.revision=")) ?? "";
    this.containers.set(name, {
      state: "running",
      image: args.at(-1) ?? "",
      imageId: this.idOf(args.at(-1) ?? ""),
      revision: label.split("=")[1] ?? "",
      health: this.health,
    });
    return ok(options.env ? name : "");
  }

  private container(verb: string, args: readonly string[], name: string) {
    const found = this.containers.get(name);
    if (verb === "rm") {
      if (!this.containers.delete(name)) throw missing("container", name);
      return ok("");
    }
    if (!found) throw missing("container", name);
    if (verb === "start") found.state = "running";
    if (verb === "stop") found.state = "exited";
    if (verb === "inspect") {
      const format = args[args.indexOf("--format") + 1] ?? "";
      const text = format.includes("Health")
        ? `${found.state} ${found.health}`
        : [found.state, found.image, found.revision, found.imageId].join("|");
      return ok(text);
    }
    return ok("");
  }

  verbs(prefix = 2) {
    return this.calls.map((call) => call.args.slice(0, prefix).join(" "));
  }
}

function ok(stdout: string) {
  return { stdout, stderr: "" };
}

function missing(kind: string, name: string) {
  return new DockerError(`docker failed`, `Error: No such ${kind}: ${name}`);
}

const spec = {
  key: "abc",
  revision: "r1",
  env: { PASEO_PASSWORD: "pw-secret", GITHUB_TOKEN: "gh-secret" },
  mounts: [],
};
const phases = () => undefined;

let docker: FakeDocker;
beforeEach(() => {
  docker = new FakeDocker();
  docker.images.add(IMAGE_TAG);
});

describe("up", () => {
  test("creates an isolated sandbox and keeps secret values out of argv", async () => {
    const handle = await createDockerProvider(docker.cli).up(spec, phases);

    const run = docker.calls.find((call) => call.args[0] === "run");
    const argv = run?.args.join(" ") ?? "";
    expect(handle).toBe("paseo-sandbox-abc");
    expect(argv).not.toContain("pw-secret");
    expect(argv).not.toContain("gh-secret");
    expect(run?.options.env).toEqual(spec.env);
    expect(argv).toContain("--security-opt no-new-privileges");
    expect(argv).toContain("--cap-drop ALL");
    expect(argv).toContain("paseo-sandbox-abc-home:/home/paseo");
    expect(argv).not.toMatch(/--publish|-p |--privileged|docker\.sock|--network host/);
    expect(argv.endsWith(IMAGE_TAG)).toBe(true);
  });

  test("mounts the requested host folders, read-only where asked, and nothing otherwise", async () => {
    await createDockerProvider(docker.cli).up(
      {
        ...spec,
        mounts: [
          { source: "/h/.codex", target: "/home/paseo/.codex", readOnly: false },
          {
            source: "/h/.codex/config.toml",
            target: "/home/paseo/.codex/config.toml",
            readOnly: true,
          },
        ],
      },
      phases,
    );

    const argv = docker.calls.find((call) => call.args[0] === "run")?.args ?? [];
    const mounts = argv.filter((_, index) => argv[index - 1] === "--mount");
    expect(mounts).toEqual([
      "type=bind,source=/h/.codex,target=/home/paseo/.codex",
      "type=bind,source=/h/.codex/config.toml,target=/home/paseo/.codex/config.toml,readonly",
    ]);
    expect(argv).not.toContain("--volume-driver");
  });

  test("builds the image from stdin only when it is missing", async () => {
    docker.images.clear();
    const seen: string[] = [];
    await createDockerProvider(docker.cli).up(spec, (phase) => seen.push(phase));
    const build = docker.calls.find((call) => call.args[0] === "build");
    expect(build?.args.at(-1)).toBe("-");
    expect(build?.options.stdin).toContain("FROM ghcr.io/getpaseo/paseo");
    expect(seen[0]).toContain("Building the runtime image");
  });

  test("an existing sandbox with the same revision is started, never recreated", async () => {
    const provider = createDockerProvider(docker.cli);
    await provider.up(spec, phases);
    await provider.stop("paseo-sandbox-abc");
    docker.calls = [];

    await provider.up(spec, phases);

    expect(docker.verbs()).toContain("container start");
    expect(docker.verbs()).not.toContain("container rm");
    expect(docker.verbs(1)).not.toContain("run");
  });

  test("new credentials recreate the container but keep the volume", async () => {
    const provider = createDockerProvider(docker.cli);
    await provider.up(spec, phases);
    docker.calls = [];

    await provider.up({ ...spec, revision: "r2" }, phases);

    expect(docker.verbs()).toContain("container rm");
    expect(docker.verbs()).not.toContain("volume rm");
    expect(docker.containers.get("paseo-sandbox-abc")?.revision).toBe("r2");
    expect(docker.volumes.has("paseo-sandbox-abc-home")).toBe(true);
  });

  test("a sandbox that never became healthy is removed with its data", async () => {
    docker.health = "unhealthy";
    await expect(createDockerProvider(docker.cli).up(spec, phases)).rejects.toThrow("unhealthy");
    expect(docker.containers.size).toBe(0);
    expect(docker.volumes.size).toBe(0);
  });

  test("a failed start never deletes a volume that already held data", async () => {
    docker.volumes.add("paseo-sandbox-abc-home");
    docker.health = "unhealthy";
    await expect(createDockerProvider(docker.cli).up(spec, phases)).rejects.toThrow();
    expect(docker.containers.size).toBe(0);
    expect(docker.volumes.has("paseo-sandbox-abc-home")).toBe(true);
  });
});

describe("exec", () => {
  test("runs as the sandbox user and hands stdin to the command, not argv", async () => {
    await createDockerProvider(docker.cli).exec({
      handle: "paseo-sandbox-abc",
      argv: ["codex", "login"],
      stdin: "secret\n",
    });
    const [call] = docker.calls;
    expect(call?.args).toEqual([
      "exec",
      "--interactive",
      "--user",
      "paseo",
      "paseo-sandbox-abc",
      "codex",
      "login",
    ]);
    expect(call?.options.stdin).toBe("secret\n");
  });
});

describe("cleanup and availability", () => {
  test("stop and destroy tolerate a sandbox that is already gone", async () => {
    const provider = createDockerProvider(docker.cli);
    await expect(provider.stop("paseo-sandbox-abc")).resolves.toBeUndefined();
    await expect(provider.destroy({ key: "abc", handle: null })).resolves.toBeUndefined();
  });

  test("destroy finds the sandbox by key when no handle was recorded", async () => {
    const provider = createDockerProvider(docker.cli);
    await provider.up(spec, phases);
    await provider.destroy({ key: "abc", handle: null });
    expect(docker.containers.size).toBe(0);
    expect(docker.volumes.size).toBe(0);
  });

  test("an unreachable Docker daemon is explained", async () => {
    docker.daemonDown = true;
    expect(await createDockerProvider(docker.cli).unavailable()).toContain("Start Docker");
  });

  test("a missing docker binary is explained", async () => {
    const provider = createDockerProvider(async () => {
      throw new DockerError("Docker is not installed on the Paseo host", "");
    });
    expect(await provider.unavailable()).toContain("not installed");
  });
});

function projectImage(
  dockerfile: string,
  extra: Partial<ImageRecipe & { kind: "dockerfile" }> = {},
) {
  const recipe: ImageRecipe = {
    kind: "dockerfile",
    dockerfile,
    context: null,
    buildArgs: {},
    extendsBuiltin: true,
    contextDigest: "",
    ...extra,
  };
  return { recipe, source: "the project's .paseo.Dockerfile" } satisfies ImageRequest;
}

const PROJECT = `ARG BASE_IMAGE\nFROM \${BASE_IMAGE}\nRUN apt-get install -y gh\n`;

describe("project images", () => {
  test("builds the built-in image first, then the project's on top of it via BASE_IMAGE", async () => {
    docker.images.clear();
    const seen: string[] = [];
    const image = projectImage(PROJECT, { buildArgs: { PYTHON: "3.12" } });
    await createDockerProvider(docker.cli).up({ ...spec, image }, (phase) => seen.push(phase));

    const builds = docker.calls.filter((call) => call.args[0] === "build");
    expect(builds.map((call) => call.args[builds[0] === call ? 2 : 3])).toEqual([
      IMAGE_TAG,
      imageTag(image.recipe),
    ]);
    const project = builds[1];
    expect(project?.options.stdin).toBe(PROJECT);
    expect(project?.args).toContain(`BASE_IMAGE=${IMAGE_TAG}`);
    expect(project?.args).toContain("PYTHON=3.12");
    expect(project?.args.at(-1)).toBe("-");
    expect(imageTag(image.recipe)).toMatch(/^paseo-sandbox-project:[0-9a-f]{12}$/);
    const run = docker.calls.find((call) => call.args[0] === "run" && !call.args.includes("--rm"));
    expect(run?.args.at(-1)).toBe(imageTag(image.recipe));
    expect(seen).toContain("Building the sandbox image from the project's .paseo.Dockerfile");
    expect(seen.some((phase) => phase.startsWith("Checking the image"))).toBe(true);
  });

  test("a configured context is sent with the Dockerfile on stdin", async () => {
    const image = projectImage(PROJECT, { context: "/tmp/ctx", contextDigest: "abc" });
    await createDockerProvider(docker.cli).up({ ...spec, image }, phases);
    const build = docker.calls.find((call) => call.args[0] === "build");
    expect(build?.args.slice(-3)).toEqual(["--file", "-", "/tmp/ctx"]);
  });

  test("a Dockerfile that does not extend the built-in image never builds it", async () => {
    docker.images.clear();
    const image = projectImage("FROM my/paseo-runtime:1\n", { extendsBuiltin: false });
    await createDockerProvider(docker.cli).up({ ...spec, image }, phases);
    const builds = docker.calls.filter((call) => call.args[0] === "build");
    expect(builds).toHaveLength(1);
    expect(builds[0]?.args.join(" ")).not.toContain("BASE_IMAGE");
  });

  test("the tag follows the Dockerfile, build args, context and base", () => {
    const base = projectImage(PROJECT).recipe;
    expect(imageTag(base)).toBe(imageTag(projectImage(PROJECT).recipe));
    expect(imageTag(projectImage(`${PROJECT}RUN true\n`).recipe)).not.toBe(imageTag(base));
    expect(imageTag(projectImage(PROJECT, { buildArgs: { A: "1" } }).recipe)).not.toBe(
      imageTag(base),
    );
    expect(imageTag(projectImage(PROJECT, { contextDigest: "x" }).recipe)).not.toBe(imageTag(base));
    expect(imageTag(projectImage(PROJECT, { extendsBuiltin: false }).recipe)).not.toBe(
      imageTag(base),
    );
    expect(imageTag({ kind: "builtin" })).toBe(IMAGE_TAG);
  });

  test("an edited Dockerfile builds once and recreates the sandbox, keeping its volume", async () => {
    const provider = createDockerProvider(docker.cli);
    await provider.up({ ...spec, image: projectImage(PROJECT) }, phases);
    docker.calls = [];
    const seen: string[] = [];

    const edited = projectImage(`${PROJECT}RUN pip install ruff\n`);
    await provider.up({ ...spec, image: edited }, (phase) => seen.push(phase));

    expect(docker.verbs(1).filter((verb) => verb === "build")).toHaveLength(1);
    expect(docker.verbs()).toContain("container rm");
    expect(docker.verbs()).not.toContain("volume rm");
    expect(seen).toContain("Switching to the new runtime image");
    expect(docker.containers.get("paseo-sandbox-abc")?.image).toBe(imageTag(edited.recipe));
    expect(docker.volumes.has("paseo-sandbox-abc-home")).toBe(true);

    // Unchanged on the next start: no build and no recreation.
    docker.calls = [];
    await provider.up({ ...spec, image: edited }, phases);
    expect(docker.verbs(1)).not.toContain("build");
    expect(docker.verbs()).not.toContain("container rm");
  });

  test("switching from the built-in image to a project image recreates the sandbox", async () => {
    const provider = createDockerProvider(docker.cli);
    await provider.up(spec, phases);
    docker.calls = [];
    await provider.up({ ...spec, image: projectImage(PROJECT) }, phases);
    expect(docker.verbs()).toContain("container rm");
  });

  test("rebuild skips the layer cache, and the new image id recreates the sandbox", async () => {
    const provider = createDockerProvider(docker.cli);
    const image = projectImage(PROJECT);
    await provider.up({ ...spec, image }, phases);
    docker.calls = [];

    await provider.up({ ...spec, image: { ...image, rebuild: true } }, phases);

    const build = docker.calls.find((call) => call.args[0] === "build");
    expect(build?.args).toContain("--no-cache");
    // Only the project image is rebuilt; the pinned built-in image is reused.
    expect(docker.verbs(1).filter((verb) => verb === "build")).toHaveLength(1);
    expect(docker.verbs()).toContain("container rm");
  });

  test("an image that breaks the runtime contract is refused with what is missing", async () => {
    docker.contract = "missing: user:paseo paseo\nagents: omp\n";
    const image = projectImage("FROM debian:12\n", { extendsBuiltin: false });
    const tag = imageTag(image.recipe);
    docker.noHealthcheck.add(tag);

    const failure = createDockerProvider(docker.cli).up({ ...spec, image }, phases);

    await expect(failure).rejects.toThrow(/does not meet the sandbox runtime contract/);
    await expect(failure).rejects.toThrow("Missing: HEALTHCHECK, user:paseo, paseo");
    await expect(failure).rejects.toThrow(`FROM \${BASE_IMAGE}`);
    expect(docker.images.has(tag)).toBe(false);
    expect(docker.containers.size).toBe(0);
  });

  test("missing agent CLIs only warn", async () => {
    docker.contract = "missing:\nagents: omp opencode\n";
    const image = projectImage(PROJECT);
    await expect(createDockerProvider(docker.cli).up({ ...spec, image }, phases)).resolves.toBe(
      "paseo-sandbox-abc",
    );
  });

  test("a prebuilt image is pulled when missing, checked, and run as named", async () => {
    const image: ImageRequest = {
      recipe: { kind: "image", image: "ghcr.io/acme/paseo-runtime:2" },
      source: "the project's .paseo/sandbox.json",
    };
    await createDockerProvider(docker.cli).up({ ...spec, image }, phases);
    expect(docker.verbs(1)).toContain("pull");
    expect(docker.verbs(1)).not.toContain("build");
    expect(docker.containers.get("paseo-sandbox-abc")?.image).toBe("ghcr.io/acme/paseo-runtime:2");
  });
});
