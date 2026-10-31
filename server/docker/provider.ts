import type { ImageRequest, SandboxProvider, SandboxRuntimeStatus, SandboxSpec } from "../provider";
import { type DockerCli, DockerError, isAbsent } from "./cli";
import { DOCKERFILE, IMAGE_TAG } from "./image";
import { CONTRACT_CHECK, imageTag, parseContractReport } from "./recipe";

const REVISION_LABEL = "sh.paseo-plugins.sandbox.revision";
const SOURCE_LABEL = "sh.paseo-plugins.sandbox.image-source";
const BUILTIN: ImageRequest = { recipe: { kind: "builtin" }, source: "the built-in runtime" };
const HEALTH_TIMEOUT_MS = 120_000;
const BUILD_TIMEOUT_MS = 20 * 60_000;
const DAEMON_UNREACHABLE = /cannot connect|is the docker daemon running|permission denied/i;

function containerName(key: string) {
  return `paseo-sandbox-${key}`;
}

function volumeName(container: string) {
  return `${container}-home`;
}

/**
 * One container per sandbox and one named volume for /home/paseo. No published ports. Host
 * folders are mounted only when the spec asks for them.
 */
export function createDockerProvider(docker: DockerCli): SandboxProvider {
  async function inspect(name: string) {
    try {
      const { stdout } = await docker([
        "container",
        "inspect",
        "--format",
        `{{.State.Status}}|{{.Config.Image}}|{{index .Config.Labels "${REVISION_LABEL}"}}|{{.Image}}`,
        name,
      ]);
      const [state = "", image = "", revision = "", imageId = ""] = stdout.trim().split("|");
      return { state, image, revision, imageId };
    } catch (error) {
      if (isAbsent(error)) return null;
      throw error;
    }
  }

  /** The image's id, or null when it is not present locally. */
  async function imageId(tag: string) {
    try {
      const { stdout } = await docker(["image", "inspect", "--format", "{{.Id}}", tag]);
      return stdout.trim();
    } catch (error) {
      if (!isAbsent(error)) throw error;
      return null;
    }
  }

  async function ensureBuiltin(onPhase: (phase: string) => void) {
    const present = await imageId(IMAGE_TAG);
    if (present !== null) return present;
    onPhase("Building the runtime image (first run only, a few minutes)");
    // The Dockerfile copies nothing, so it needs no build context.
    await docker(["build", "--tag", IMAGE_TAG, "-"], {
      stdin: DOCKERFILE,
      timeoutMs: BUILD_TIMEOUT_MS,
    });
    return (await imageId(IMAGE_TAG)) ?? "";
  }

  /**
   * Rejects an image that cannot host the sandbox daemon, naming what is missing, instead of
   * letting it fail later as a container that never turns healthy.
   */
  async function validate(tag: string, source: string, onPhase: (phase: string) => void) {
    onPhase(`Checking the image from ${source}`);
    const { stdout: health } = await docker([
      "image",
      "inspect",
      "--format",
      "{{json .Config.Healthcheck}}",
      tag,
    ]);
    const missing: string[] = [];
    if (!health.trim() || health.trim() === "null") missing.push("HEALTHCHECK");
    let report: string;
    try {
      ({ stdout: report } = await docker(
        ["run", "--rm", "--network", "none", "--entrypoint", "sh", tag, "-c", CONTRACT_CHECK],
        { timeoutMs: 60_000 },
      ));
    } catch (error) {
      report = "";
      missing.push(`sh (${error instanceof Error ? error.message : String(error)})`);
    }
    const parsed = parseContractReport(report);
    if (report && !report.includes("missing:")) missing.push("a readable contract check");
    missing.push(...parsed.missing);
    if (missing.length > 0)
      throw new Error(
        `The image from ${source} (${tag}) does not meet the sandbox runtime contract. Missing: ${missing.join(", ")}. Start the Dockerfile with \`ARG BASE_IMAGE\` and \`FROM \${BASE_IMAGE}\` to extend the built-in runtime, or provide these yourself.`,
      );
    if (parsed.missingAgents.length > 0)
      console.warn(
        `sandbox: the image from ${source} has no ${parsed.missingAgents.join(", ")}; those agents will be unavailable.`,
      );
  }

  /** Builds or pulls what the request names, once per tag. Returns the tag and its image id. */
  async function ensureImage(request: ImageRequest, onPhase: (phase: string) => void) {
    const { recipe, source, rebuild = false } = request;
    if (recipe.kind === "builtin") return { tag: IMAGE_TAG, id: await ensureBuiltin(onPhase) };
    const tag = imageTag(recipe);
    if (recipe.kind === "image") {
      if (rebuild || (await imageId(tag)) === null) {
        onPhase(`Pulling ${tag} from ${source}`);
        await docker(["pull", "--quiet", tag], { timeoutMs: BUILD_TIMEOUT_MS });
      }
      await validate(tag, source, onPhase);
      return { tag, id: (await imageId(tag)) ?? "" };
    }
    if (recipe.extendsBuiltin) await ensureBuiltin(onPhase);
    const existing = rebuild ? null : await imageId(tag);
    if (existing !== null) return { tag, id: existing };
    onPhase(`Building the sandbox image from ${source}`);
    const buildArgs = {
      ...recipe.buildArgs,
      ...(recipe.extendsBuiltin ? { BASE_IMAGE: IMAGE_TAG } : {}),
    };
    await docker(
      [
        "build",
        "--quiet",
        "--tag",
        tag,
        "--label",
        `${SOURCE_LABEL}=${source}`,
        ...(rebuild ? ["--no-cache"] : []),
        ...Object.entries(buildArgs).flatMap(([name, value]) => [
          "--build-arg",
          `${name}=${value}`,
        ]),
        // Without a context the Dockerfile itself is the build input, as for the built-in image.
        ...(recipe.context ? ["--file", "-", recipe.context] : ["-"]),
      ],
      { stdin: recipe.dockerfile, timeoutMs: BUILD_TIMEOUT_MS },
    );
    try {
      await validate(tag, source, onPhase);
    } catch (error) {
      // Untag it, so the next start checks a fixed Dockerfile instead of reusing this one.
      await docker(["image", "rm", "--force", tag]).catch(() => undefined);
      throw error;
    }
    return { tag, id: (await imageId(tag)) ?? "" };
  }

  async function waitHealthy(name: string) {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    for (;;) {
      const { stdout } = await docker([
        "container",
        "inspect",
        "--format",
        "{{.State.Status}} {{.State.Health.Status}}",
        name,
      ]);
      const [state, health] = stdout.trim().split(" ");
      if (state !== "running") throw new Error(`The sandbox stopped while starting (${state}).`);
      if (health === "healthy") return;
      if (health === "unhealthy") throw new Error("The sandbox daemon reported itself unhealthy.");
      if (Date.now() > deadline)
        throw new Error("The sandbox daemon did not become healthy in 2 minutes.");
      await new Promise((done) => setTimeout(done, 1000));
    }
  }

  async function volumeExists(name: string) {
    try {
      await docker(["volume", "inspect", name]);
      return true;
    } catch (error) {
      if (isAbsent(error)) return false;
      throw error;
    }
  }

  async function removeIfPresent(args: readonly string[]) {
    try {
      await docker(args);
    } catch (error) {
      if (!isAbsent(error)) throw error;
    }
  }

  async function create(name: string, spec: SandboxSpec, tag: string) {
    const volume = volumeName(name);
    const volumeHeldData = await volumeExists(volume);
    await docker(["volume", "create", volume]);
    try {
      await docker(
        [
          "run",
          "--detach",
          "--name",
          name,
          "--label",
          `${REVISION_LABEL}=${spec.revision}`,
          "--volume",
          `${volume}:/home/paseo`,
          // `--mount` fails on a missing source, where `--volume` would create it on the host.
          ...spec.mounts.flatMap(({ source, target, readOnly }) => [
            "--mount",
            `type=bind,source=${source},target=${target}${readOnly ? ",readonly" : ""}`,
          ]),
          "--security-opt",
          "no-new-privileges",
          // The image entrypoint starts as root only to prepare the volume and drop to `paseo`.
          "--cap-drop",
          "ALL",
          "--cap-add",
          "CHOWN",
          "--cap-add",
          "SETUID",
          "--cap-add",
          "SETGID",
          "--cap-add",
          "DAC_OVERRIDE",
          "--health-interval",
          "2s",
          "--health-start-period",
          "0s",
          ...Object.keys(spec.env).flatMap((variable) => ["--env", variable]),
          tag,
        ],
        { env: spec.env },
      );
      await waitHealthy(name);
    } catch (error) {
      // Remove what this call made. A volume that already held data is never deleted here.
      await docker(["container", "rm", "--force", name]).catch(() => undefined);
      if (!volumeHeldData) await docker(["volume", "rm", "--force", volume]).catch(() => undefined);
      throw error;
    }
  }

  return {
    id: "docker",

    async unavailable() {
      try {
        await docker(["version", "--format", "{{.Server.Version}}"], { timeoutMs: 10_000 });
        return null;
      } catch (error) {
        if (!(error instanceof DockerError)) throw error;
        if (DAEMON_UNREACHABLE.test(error.stderr))
          return "Docker is installed but its daemon is not reachable. Start Docker, or add the Paseo host's user to the docker group.";
        return error.message;
      }
    },

    async up(spec, onPhase) {
      const name = containerName(spec.key);
      const image = await ensureImage(spec.image ?? BUILTIN, onPhase);
      const existing = await inspect(name);
      const newImage =
        existing !== null &&
        (existing.image !== image.tag || Boolean(image.id && existing.imageId !== image.id));
      const outdated = existing && (existing.revision !== spec.revision || newImage);
      if (existing && !outdated) {
        if (existing.state !== "running") {
          onPhase("Starting the sandbox");
          await docker(["container", "start", name]);
        }
        await waitHealthy(name);
        return name;
      }
      if (outdated) {
        // The volume stays, so /home/paseo (checkout, logins, daemon identity) survives.
        onPhase(newImage ? "Switching to the new runtime image" : "Applying new credentials");
        await docker(["container", "rm", "--force", name]);
      }
      onPhase(
        spec.image && spec.image.recipe.kind !== "builtin"
          ? `Starting the sandbox (image from ${spec.image.source})`
          : "Starting the sandbox",
      );
      await create(name, spec, image.tag);
      return name;
    },

    async status(handle): Promise<SandboxRuntimeStatus> {
      const container = await inspect(handle);
      if (!container) return "missing";
      return container.state === "running" ? "running" : "stopped";
    },

    async exec({ handle, argv, stdin, timeoutMs }) {
      const { stdout } = await docker(
        ["exec", "--interactive", "--user", "paseo", handle, ...argv],
        { stdin, timeoutMs },
      );
      return stdout;
    },

    stop(handle) {
      return removeIfPresent(["container", "stop", "--time", "10", handle]);
    },

    async destroy({ key }) {
      const name = containerName(key);
      await removeIfPresent(["container", "rm", "--force", name]);
      await removeIfPresent(["volume", "rm", "--force", volumeName(name)]);
    },
  };
}
