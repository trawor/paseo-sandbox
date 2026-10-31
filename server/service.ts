import { createHash, randomBytes, randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import type { RpcInput } from "@getpaseo/plugin";
import { CREDENTIAL_PRESETS } from "../shared/credentials";
import type { createSandbox, Sandbox } from "../shared/sandbox";
import { sandboxEnvironment } from "./credentials";
import { ENABLE_OMP } from "./daemon-config";
import type { SandboxHosts } from "./hosts";
import { resolveLocalProject, resolveMounts } from "./mounts";
import { relayConnection } from "./pairing";
import type { ResolvedImage } from "./project-image";
import type { HostMount, SandboxProvider } from "./provider";
import { parseRepository } from "./repository";
import type { Store } from "./store";

const ONLINE_TIMEOUT_MS = 60_000;
const CLONE_TIMEOUT_MS = 30 * 60_000;

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** What the host contributes when its agent logins are shared. Each rejects with what to fix. */
export interface HostLogins {
  mounts(enabled: readonly string[]): Promise<HostMount[]>;
  githubToken(): Promise<string>;
}

/** Picks a sandbox's runtime image on the Paseo host, before the sandbox is created. */
export interface ProjectImages {
  resolve(input: {
    /** Exactly one of `repoUrl` and `localPath` is set. */
    repoUrl: string | null;
    localPath: string | null;
    /** The token the sandbox itself would clone with, for reading a private project's config. */
    githubToken: string | undefined;
    rebuild: boolean;
  }): Promise<ResolvedImage>;
}

/** The upstream behavior: every sandbox runs the built-in runtime. */
export const BUILTIN_IMAGES: ProjectImages = {
  async resolve({ rebuild }) {
    return {
      request: { recipe: { kind: "builtin" }, source: "the built-in runtime", rebuild },
      env: {},
      mounts: [],
      dispose: async () => undefined,
    };
  },
};

function sortedJson(values: Record<string, string>) {
  return JSON.stringify(Object.entries(values).sort(([a], [b]) => a.localeCompare(b)));
}

function mountKey(mounts: readonly HostMount[]) {
  return JSON.stringify(
    [...mounts]
      .sort((a, b) => a.target.localeCompare(b.target))
      .map(({ source, target, readOnly }) => [source, target, readOnly]),
  );
}

/** Lifecycle of project sandboxes. Long operations run in the background and report through `list`. */
export function createSandboxService(
  provider: SandboxProvider,
  store: Store,
  hostLogins: HostLogins,
  images: ProjectImages = BUILTIN_IMAGES,
) {
  const busy = new Map<string, string>();
  const failures = new Map<string, string>();
  /** Tokens read from the host. They are in no saved state, so redaction must be told. */
  const hostTokens = new Set<string>();

  /** Failure text is logged and shown to every client, so no saved value may appear in it. */
  async function redact(id: string, message: string) {
    const state = await store.read();
    const secrets = [
      state.sandboxes[id]?.password,
      ...Object.values(state.credentials).map((credential) => credential.value),
      ...hostTokens,
    ].filter((secret): secret is string => Boolean(secret) && secret.length >= 8);
    return secrets.reduce((text, secret) => text.split(secret).join("***"), message);
  }

  /** Rejects a second operation on the same sandbox, then runs `work` without blocking the caller. */
  function begin(
    id: string,
    phase: string,
    work: (setPhase: (phase: string) => void) => Promise<void>,
  ) {
    const running = busy.get(id);
    if (running) throw new Error(`This sandbox is busy: ${running.toLowerCase()}.`);
    busy.set(id, phase);
    failures.delete(id);
    void work((next) => busy.set(id, next))
      .catch(async (error: unknown) => {
        const message = await redact(id, messageOf(error));
        console.error(`sandbox ${id}: ${phase} failed: ${message}`);
        failures.set(id, message);
      })
      .finally(() => busy.delete(id));
  }

  async function record(id: string) {
    const found = (await store.read()).sandboxes[id];
    if (!found) throw new Error("That sandbox no longer exists.");
    return found;
  }

  async function waitOnline(hosts: SandboxHosts, registrationId: string) {
    const deadline = Date.now() + ONLINE_TIMEOUT_MS;
    for (;;) {
      const host = (await hosts.list()).find((h) => h.registrationId === registrationId);
      if (host?.status === "online" && host.serverId) return host.serverId;
      if (Date.now() > deadline)
        throw new Error(
          host?.error?.message ??
            "The sandbox started but Paseo could not reach it through the relay.",
        );
      await sleep(1000);
    }
  }

  /** Brings the sandbox up with the current credentials and registers it as a connected host. */
  async function provision(
    hosts: SandboxHosts,
    id: string,
    setPhase: (phase: string) => void,
    rebuild: boolean,
  ) {
    // One snapshot drives the environment, the logins and the recorded revision, so a credential
    // saved meanwhile is reported as stale instead of being half applied.
    const state = await store.read();
    const current = await record(id);
    const { env, hostLogins: shared, revision } = sandboxEnvironment(state, current);
    const loginMounts = await hostLogins.mounts(shared);
    // A local project is checked again at every start: the folder may have moved since.
    const local = current.localPath
      ? await resolveLocalProject(current.localPath, current.localTarget ?? undefined)
      : null;
    if (local && process.platform === "linux") {
      // Linux bind mounts keep host ownership; the sandbox user is uid 1000.
      const { uid } = await stat(local.path);
      if (uid !== 1000)
        console.warn(
          `sandbox ${id}: ${local.path} is owned by uid ${uid}, not 1000; the sandbox user may not be able to write it.`,
        );
    }
    const projectMount: HostMount[] = local
      ? [{ source: local.path, target: local.target, readOnly: false }]
      : [];
    if (shared.includes("github")) {
      const token = await hostLogins.githubToken();
      hostTokens.add(token);
      env.GITHUB_TOKEN = token;
    }
    setPhase("Reading the project's sandbox image settings");
    const image = await images.resolve({
      repoUrl: current.repoUrl,
      localPath: local?.path ?? null,
      githubToken: env.GITHUB_TOKEN,
      rebuild,
    });
    let handle: string;
    try {
      // Host config mounts, then the local project's own, after what the plugin mounts itself.
      const taken = new Map<string, string>([
        ...loginMounts.map((mount): [string, string] => [mount.target, "a shared host login"]),
        ...projectMount.map((mount): [string, string] => [
          mount.target,
          "the local project folder",
        ]),
      ]);
      const extraMounts = [...projectMount, ...(await resolveMounts(image.mounts, taken))];
      if (image.request.recipe.kind !== "builtin") setPhase(`Using ${image.request.source}`);
      // Saved credentials win over project variables. Project variables and extra mounts count as
      // a change, so the container is recreated for them; the /home/paseo volume is kept.
      const changes = Object.keys(image.env).length > 0 || extraMounts.length > 0;
      handle = await provider.up(
        {
          key: id,
          revision: changes
            ? createHash("sha256")
                .update(`${revision}\0${sortedJson(image.env)}\0${mountKey(extraMounts)}`)
                .digest("hex")
            : revision,
          env: { ...image.env, ...env },
          mounts: [...loginMounts, ...extraMounts],
          image: image.request,
        },
        setPhase,
      );
    } finally {
      await image.dispose();
    }
    await store.update((draft) => {
      const target = draft.sandboxes[id];
      if (target) target.handle = handle;
    });
    setPhase("Enabling agents");
    await provider.exec({ handle, argv: ENABLE_OMP });
    await provider.exec({ handle, argv: ["paseo", "reload"] });
    setPhase("Signing in agents");
    for (const preset of CREDENTIAL_PRESETS) {
      if (!("login" in preset)) continue;
      // A shared login is the host's own file. Signing in or out here would change the host's.
      if (shared.includes(preset.hostLogin)) continue;
      const saved = state.credentials[preset.name];
      if (saved) await provider.exec({ handle, argv: preset.login, stdin: `${saved.value}\n` });
      else await provider.exec({ handle, argv: preset.logout });
    }
    // Only now are the credentials applied. A failed login or logout leaves the sandbox stale.
    await store.update((draft) => {
      const target = draft.sandboxes[id];
      if (target) target.revision = revision;
    });
    setPhase("Connecting to the sandbox");
    const pairing = await provider.exec({
      handle,
      argv: ["paseo", "daemon", "pair", "--relay", "--json"],
    });
    const connection = relayConnection(pairing, current.password);
    // Re-adding a source with a changed connection is a conflict, and an update restarts a
    // connection stuck in error. The container is ours, so a recreated identity is expected.
    // Label and metadata are left alone after the first add: Connected hosts may have edited them.
    const existing = (await hosts.list()).find((h) => h.source.key === id);
    const host = existing
      ? await hosts.update(existing.registrationId, {
          connection,
          enabled: true,
          replaceIdentity: true,
        })
      : await hosts.add({
          connection,
          label: current.name,
          metadata: { sandboxId: id },
          sourceKey: id,
        });
    return waitOnline(hosts, host.registrationId);
  }

  async function checkout(hosts: SandboxHosts, id: string, serverId: string) {
    const { handle, repoUrl, localTarget } = await record(id);
    if (!handle) throw new Error("The sandbox has no runtime to clone into.");
    if (localTarget) {
      // A local folder is mounted, not cloned: open it where it is mounted.
      await provider.exec({ handle, argv: ["test", "-d", localTarget] }).catch((error) => {
        throw new Error(
          `The local folder is not visible at ${localTarget} in the sandbox. ${messageOf(error)}`,
        );
      });
      await hosts.openWorkspace(serverId, localTarget);
      return;
    }
    if (!repoUrl) throw new Error("The sandbox has neither a repository nor a local folder.");
    const { url, directory } = parseRepository(repoUrl);
    const cwd = `/home/paseo/${directory}`;
    const cloned = await provider.exec({ handle, argv: ["test", "-d", `${cwd}/.git`] }).then(
      () => true,
      () => false,
    );
    if (!cloned) {
      // Clone beside the target and rename, so an interrupted clone is never mistaken for a checkout.
      const partial = `${cwd}.partial`;
      try {
        await provider.exec({ handle, argv: ["rm", "-rf", partial] });
        await provider.exec({
          handle,
          argv: ["git", "clone", "--", url, partial],
          timeoutMs: CLONE_TIMEOUT_MS,
        });
        await provider.exec({ handle, argv: ["mv", "-T", partial, cwd] });
      } catch (error) {
        throw new Error(
          `Cloning ${url} failed. For a private project, save a GitHub token in Sandbox settings and start the sandbox again. ${messageOf(error)}`,
        );
      }
    }
    await hosts.openWorkspace(serverId, cwd);
  }

  async function bringUp(
    hosts: SandboxHosts,
    id: string,
    setPhase: (phase: string) => void,
    rebuild = false,
  ) {
    const serverId = await provision(hosts, id, setPhase, rebuild);
    setPhase("Opening the project");
    await checkout(hosts, id, serverId);
  }

  return {
    async list(hosts: SandboxHosts) {
      const problem = await provider.unavailable();
      const state = await store.read();
      const registered = await hosts.list();
      const sandboxes = await Promise.all(
        Object.values(state.sandboxes).map(async (item): Promise<Sandbox> => {
          const runtime = item.handle && !problem ? await provider.status(item.handle) : "missing";
          const host = registered.find((h) => h.source.key === item.id);
          return {
            id: item.id,
            name: item.name,
            repoUrl: item.repoUrl,
            localPath: item.localPath,
            localTarget: item.localTarget,
            createdAt: item.createdAt,
            runtime,
            host: host
              ? { status: host.status, serverId: host.serverId, error: host.error?.message ?? null }
              : null,
            stale:
              runtime === "running" && item.revision !== sandboxEnvironment(state, item).revision,
            busy: busy.get(item.id) ?? null,
            error: failures.get(item.id) ?? null,
          };
        }),
      );
      sandboxes.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return { runtime: { available: !problem, problem }, sandboxes };
    },

    async create(hosts: SandboxHosts, input: RpcInput<typeof createSandbox>) {
      if (Boolean(input.repoUrl) === Boolean(input.localPath))
        throw new Error("Give either a repository or a local folder, not both.");
      const local = input.localPath
        ? await resolveLocalProject(input.localPath, input.target)
        : null;
      const repository = input.repoUrl ? parseRepository(input.repoUrl) : null;
      const problem = await provider.unavailable();
      if (problem) throw new Error(problem);
      const id = randomUUID().slice(0, 12);
      await store.update((draft) => {
        draft.sandboxes[id] = {
          id,
          name: input.name?.trim() || local?.name || repository?.directory || id,
          repoUrl: repository?.url ?? null,
          localPath: local?.path ?? null,
          localTarget: local?.target ?? null,
          handle: null,
          revision: null,
          password: randomBytes(24).toString("base64url"),
          createdAt: new Date().toISOString(),
        };
      });
      begin(id, "Creating", (setPhase) => bringUp(hosts, id, setPhase));
      return { id };
    },

    /** `rebuild` builds the project image again without the layer cache, or pulls it again. */
    async start(hosts: SandboxHosts, id: string, options: { rebuild?: boolean } = {}) {
      await record(id);
      begin(id, options.rebuild ? "Rebuilding" : "Starting", (setPhase) =>
        bringUp(hosts, id, setPhase, options.rebuild ?? false),
      );
    },

    async stop(id: string) {
      const { handle } = await record(id);
      begin(id, "Stopping", async () => {
        if (handle) await provider.stop(handle);
      });
    },

    async remove(hosts: SandboxHosts, id: string) {
      const { handle } = await record(id);
      begin(id, "Removing", async () => {
        await provider.destroy({ key: id, handle });
        for (const host of await hosts.list()) {
          if (host.source.key === id) await hosts.remove(host.registrationId);
        }
        await store.update((draft) => {
          delete draft.sandboxes[id];
        });
      });
    },
  };
}

export type SandboxService = ReturnType<typeof createSandboxService>;
