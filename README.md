# Sandbox

> Fork of [`@omercnet/paseo-sandbox`](https://github.com/omercnet/paseo-plugins/tree/main/sandbox) 0.3.0 (MIT) that runs local folders as well as repositories, lets each project choose its runtime image with `.paseo.Dockerfile` or `.paseo/sandbox.json`, and mounts extra folders from JSON config. See [Local folders and mounts](#local-folders-and-mounts) and [Project runtime images](#project-runtime-images).

A Paseo plugin that runs a project's workspaces, agents and terminals inside a Docker container with its own Paseo daemon. See [OVERVIEW.md](OVERVIEW.md) for behavior and limits.

## How it works

Paseo 0.13 connected hosts do the heavy lifting. The plugin starts a container from `runtime/Dockerfile`, reads its relay pairing link, and registers it with `paseo.hosts.add`. Paseo then routes the sidebar project, agents, terminals, files and Git for that host. The plugin writes no remote file, terminal or provider code, and no host-management UI: the Connected hosts plugin shows and edits the registered hosts.

```text
controller daemon                          sandbox container (one per project)
  plugin: sandbox  --docker run/exec-->     Paseo daemon + claude, codex, opencode, omp, git
  hosts.add(relay link + password)  <--TLS relay, E2EE-->  /home/paseo (named volume)
```

## Sandbox providers

`server/provider.ts` is the whole interface. A provider turns a `SandboxSpec` (key, env, revision) into a running daemon and answers `status`, `exec`, `stop` and `destroy`. Handles are opaque strings that only the issuing provider reads, so `server/service.ts`, the store and the UI never see a container id. `server/docker/provider.ts` is the only implementation; it reaches Docker through an injected `DockerCli`, so its unit tests run against an in-memory Docker. One implementation is a deliberate seam, requested ahead of the E2B provider.

To add a provider, implement the interface and pass it to `createSandboxService` in `index.server.ts`. Its contract:

- `up` is idempotent, resolves once the daemon answers, and recreates the sandbox when `spec.revision` changed while keeping stored data.
- `exec` runs as the unprivileged sandbox user and accepts stdin.
- Data lives only under `/home/paseo`. Removing the sandbox removes that data, and stopping it never does.

## Runtime image

`runtime/Dockerfile` adds only the agent CLIs and a Git credential helper to the official `ghcr.io/getpaseo/paseo` image, pinned by version and digest. A standalone base cannot be smaller: the Paseo daemon package alone is about 600 MB. The file's header lists the runtime contract any other sandbox format must meet. No secret is baked in; credentials arrive through the environment, and Codex is signed in through stdin.

The plugin bundle cannot read sibling files, so `server/docker/image.ts` embeds the Dockerfile. After editing it, run `npm run embed:dockerfile`; a test fails when they differ. The image tag is derived from the file, so an updated plugin builds a new image once.

## Local folders and mounts

`sandbox.create` takes exactly one of `repoUrl` and `localPath` (plus an optional `target`, and a `name` that defaults to the repository or folder name). `server/mounts.ts` validates a local folder: `~` is expanded against the daemon user's home, the path is resolved with `realpath`, it must be a folder, and `/`, the home folder and its parents are refused. The default target is `/workspace/<folder name>` with characters outside `[A-Za-z0-9_.-]` replaced, not the host path: a macOS `/Users/...` path inside the container would sit under folders the sandbox user does not own. The record keeps `localPath` and `localTarget`; at each start the folder is checked again, mounted read-write as a `HostMount`, and opened with `hosts.openWorkspace` after `test -d`, instead of cloning.

Extra mounts reuse the same `HostMount` list as shared host logins. `mountsSchema` (strict, max 16, unique targets, `readOnly` default true, no target at/under/above `/home/paseo` or on system folders, no comma or quote since `--mount` cannot carry them) is used by both the host config and `.paseo/sandbox.json`. `resolveImage` collects host config mounts, then project mounts, and refuses a project `mounts` unless the project is a local folder (`trusted`). For a local folder the project config, `.paseo.Dockerfile`, Dockerfile and context are read in place (`localCheckout`: no fetch, nothing removed). `resolveMounts` expands `~`, requires each source to exist, and rejects a target already taken by a login mount, the project folder or an earlier entry, naming the config key. Project env and the extra mount set are folded into the provider revision, so a change recreates the container through the existing revision check and keeps the volume.

## Project runtime images

The project is cloned inside the container after the container exists, so the image cannot come from that checkout. `server/project-files.ts` therefore reads the default branch on the Paseo host first: `git clone --depth 1 --filter=blob:none --no-checkout` plus a non-cone sparse checkout of `/.paseo/sandbox.json` and `/.paseo.Dockerfile` into a private temp folder, then `sparse-checkout add` for a configured Dockerfile or context. Only those blobs are downloaded. It reuses the URL parsing of `server/repository.ts` and the GitHub token the sandbox itself clones with, passed as an `http.https://github.com/.extraheader` through `GIT_CONFIG_*` environment variables (never argv, never a file, never sent to another host). Plain git was chosen over the GitHub contents API because the plugin already accepts any https git host, and over a throwaway container because it needs no image before the image is known. Before building, the `.git` folder is removed so a context is plain files; the temp folder is deleted after the build.

`server/project-image.ts` holds the resolution order (project config, `.paseo.Dockerfile`, host default, built-in), the zod schemas of `.paseo/sandbox.json` and the host settings, and the context digest. It returns an `ImageRequest` (`server/provider.ts`): a built-in, Dockerfile or prebuilt-image recipe plus a human-readable source. `server/docker/recipe.ts` turns a recipe into a tag, `paseo-sandbox-project:<sha256(Dockerfile, sorted build args, context digest, built-in tag)[:12]>`, and holds the contract check. `server/docker/provider.ts`:

- builds the built-in image first when the recipe extends it, then the project image with `--build-arg BASE_IMAGE=<built-in tag>`, from stdin (`-`) or with `--file - <context>`;
- runs the contract check on every non-built-in image (`docker image inspect` for a HEALTHCHECK, then `docker run --rm --network none --entrypoint sh` for user `paseo` uid 1000, `paseo`, `git`, `node`; missing agent CLIs only warn) and untags an image that fails;
- recreates a container whose image tag or image id differs from the resolved one, so an edited Dockerfile or a rebuild replaces the container and keeps the volume.

Project `env` values join the provider revision (the stored credential revision, and so the "stale" flag, is unchanged). `sandbox.start` takes `rebuild: true` for `--no-cache` (or a fresh pull). `PASEO_SANDBOX_ALLOW_INSECURE_REPOS=1` lets `parseRepository` accept plain `http://` URLs; it exists only for end-to-end tests against a local git server and must not be set otherwise.

Examples: [`examples/.paseo.Dockerfile`](examples/.paseo.Dockerfile), [`examples/.paseo/sandbox.json`](examples/.paseo/sandbox.json) with [`examples/docker/`](examples/docker); for a local folder with mounts, [`examples/local-folder/.paseo/sandbox.json`](examples/local-folder/.paseo/sandbox.json); host config, [`examples/host-config.json`](examples/host-config.json) (copy to `$PASEO_HOME/plugin-data/sandbox/config.json`). Install as root with `HOME=/root` in your Dockerfile: the base image points `HOME` at `/home/paseo`, and root-owned files there end up in the sandbox user's volume.

## Credentials

Settings are readable by every client, so credentials never go there. `server/store.ts` keeps them in `$PASEO_HOME/plugin-data/sandbox/state.json` (0600) and the RPCs return names and dates only. Evidence behind the delivery choices:

| Credential | Delivery | Checked |
| --- | --- | --- |
| `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY` | environment | `claude auth status` reports `oauth_token` and `api_key` |
| `CODEX_API_KEY` | `codex login --with-api-key` on stdin | Paseo's Codex provider ignores the variable and sends a stored login |
| `OPENAI_API_KEY`, `GITHUB_TOKEN`, custom | environment | OpenCode lists keys from the environment; Git reads the token through the credential helper |

Shared host logins (`server/host-logins.ts`) are the alternative to saving a value. Claude, Codex, OpenCode and OMP are bind-mounted from the host (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `$XDG_DATA_HOME/opencode`, `PI_CODING_AGENT_DIR` or `~/.omp/agent`) because their logins rotate: one live file keeps one token lineage, where a copy would fork it. Entries a host agent would run or obey (hooks, skills, settings, `config.toml`) are overlaid read-only, which is a best-effort list and not a boundary. Missing folders on the list are created empty on the host first (Docker would otherwise create a nested mount target as a root-owned folder in the shared directory), missing files are skipped. GitHub is passed as a value from `gh auth token` because that token is not rotated. OMP is mounted at `/home/paseo/.omp-agent` with `PI_CODING_AGENT_DIR` pointing there, not at `~/.omp/agent`: Docker creates a missing mount parent as root, and omp could not then write `~/.omp/run`. OMP is a bun program, so the image installs `bun` beside it, and the sandbox daemon enables Paseo's OMP provider, which ships off. The other built-in Paseo providers (Copilot, Pi, Antigravity, Muse) are not installed in the image. A shared login suppresses the matching saved value, since `codex login` or `codex logout` in the sandbox would rewrite the host's `auth.json`. The real-Docker test mutation-checks both the overlay and that suppression.

Nothing here was verified against a paid endpoint; checks used fake keys and observed which one each CLI sent.

## Develop

```sh
bun install
npm run check && npm run typecheck && npm test
```

Install this fork into a Paseo daemon from a local checkout (there is no npm release):

```sh
npm pack && mkdir -p ~/paseo-sandbox-fork && tar xzf trawor-paseo-sandbox-*.tgz -C ~/paseo-sandbox-fork --strip-components=1
paseo plugin remove sandbox   # only if @omercnet/paseo-sandbox is installed: same plugin id
paseo plugin install ~/paseo-sandbox-fork
```

`npm test` runs the unit tests against in-memory fakes. `npm run test:e2e:local` runs `tests/integration/*.local.e2e.test.ts` against real Docker: it builds the runtime image on first use (a few minutes, needs network), then starts, restarts, recreates and removes real containers and clones a public project. It fails, rather than skips, when Docker is unavailable. CI does not run it.

Verify against an isolated daemon, never the default one, from the repository root:

```sh
.agents/skills/deliver/scripts/dev-daemon.sh up sandbox
.agents/skills/deliver/scripts/dev-daemon.sh down sandbox
```

Remove leftovers with `docker rm -f` and `docker volume rm` on names starting `paseo-sandbox-`.

## Layout

- `shared/`: RPC contracts and the credential presets.
- `server/provider.ts`: the sandbox-provider interface. `server/docker/`: the Docker implementation (`provider.ts`, `cli.ts`, generated `image.ts`).
- `server/mounts.ts`: mount and local-folder validation and resolution.
- `server/project-image.ts`, `server/project-files.ts`, `server/docker/recipe.ts`: per-project image resolution, the host-side sparse fetch, tags and the contract check.
- `server/service.ts`: create, start, stop, remove, pairing, cloning and host registration. `server/hosts.ts` is the slice of connected hosts it uses.
- `server/credentials.ts`, `server/store.ts`, `server/host-logins.ts`: saved credentials, shared host logins, the sandbox environment and the private state file. `server/pairing.ts`, `server/repository.ts`: relay connection string and project URL parsing.
- `client/`: the Sandboxes screen, the credentials section shown in Settings, and the sidebar item.
