Sandbox runs one project in its own Docker container. The container holds a complete Paseo daemon, so the project's workspaces, agents, terminals and Git commands all execute inside it instead of on your machine. Paseo shows the project in the normal sidebar as a connected host, and its agents appear under the Subagents track of any agent that starts them.

Open **Sandboxes** in the sidebar, enter a project (`owner/repo` on GitHub or an https URL) and press Create. The plugin builds the runtime image the first time, starts the container, clones the project inside it, registers the container as a host and opens the project. Stop keeps the project data. Remove deletes the container and everything stored in it.

The plugin only provisions. Each sandbox is saved as an ordinary connected host, so its connection status, label and metadata can be inspected and edited in the Connected hosts plugin, or with `paseo host`. Starting a sandbox refreshes only its connection and re-enables it; it never rewrites a label or metadata you changed.

## Project runtime images

Each sandbox runs the built-in runtime image unless the project brings its own. When a sandbox is created or started, the plugin reads the project's default branch on this host (a shallow, sparse fetch of only the files below, with the same GitHub token the sandbox clones with) and picks the first match:

1. **`.paseo/sandbox.json`** in the project, a small config file (see below).
2. **`.paseo.Dockerfile`** at the project root.
3. **This host's default**, from `plugin-data/sandbox/config.json` under the daemon's Paseo home or the matching environment variables.
4. **The built-in runtime image.**

A project Dockerfile normally extends the built-in runtime, so it only adds tools:

```Dockerfile
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends gh ripgrep python3 \
 && rm -rf /var/lib/apt/lists/*
```

The plugin builds the built-in image first and passes its tag as `BASE_IMAGE`. A Dockerfile that does not mention `BASE_IMAGE` stands alone and must provide the runtime contract itself (Paseo daemon, user `paseo` with uid 1000, git, node, a HEALTHCHECK). Every non-built-in image is checked after it is built or pulled, and one that misses part of the contract is refused with the list of what is missing.

`.paseo/sandbox.json` (every field optional):

```json
{
  "dockerfile": "docker/sandbox.Dockerfile",
  "context": "docker",
  "buildArgs": { "NODE_TOOLS": "pnpm@10" },
  "env": { "PIP_DISABLE_PIP_VERSION_CHECK": "1" }
}
```

- `dockerfile`: repository path of the Dockerfile, default `.paseo.Dockerfile`.
- `context`: repository folder sent as the build context, so `COPY` works. Without it the Dockerfile is built with no context, like the built-in image. `"."` fetches the whole default branch.
- `buildArgs`, `env`: non-secret values only. Names that look like secrets (`*TOKEN*`, `*KEY*`, `*SECRET*`, `*PASSWORD*`) and names the plugin sets are refused. `env` reaches the sandbox daemon; saved credentials win over it.
- `image`: a prebuilt image to pull and run instead of building (not with `dockerfile` or `context`).
- `extends`: `builtin` or `none`, to override the `BASE_IMAGE` detection.

An image is built once per content: the tag is a digest of the Dockerfile, build arguments, context files and the built-in image it extends. Start or Restart reads the project again, so after you push a changed Dockerfile the next start builds it and recreates the container, keeping `/home/paseo` (checkout, logins, history). **Rebuild image** on the Sandboxes screen rebuilds without the layer cache (or pulls the image again) and recreates the sandbox the same way. The project checkout inside the sandbox is not pulled by this.

Host settings, in `plugin-data/sandbox/config.json` (environment variables win, both are read at every start):

| Setting | Environment variable | Meaning |
| --- | --- | --- |
| `projectDockerfile`: `auto` (default) or `off` | `PASEO_SANDBOX_PROJECT_DOCKERFILE` | `off` never reads project files; every sandbox uses the host default or the built-in image |
| `defaultDockerfile` (absolute path) | `PASEO_SANDBOX_DEFAULT_DOCKERFILE` | Dockerfile for projects without their own |
| `defaultContext` (absolute path) | `PASEO_SANDBOX_DEFAULT_CONTEXT` | Build context for that Dockerfile |
| `defaultImage` | `PASEO_SANDBOX_DEFAULT_IMAGE` | Prebuilt image for projects without their own; wins over `defaultDockerfile` |
| `defaultBuildArgs` | | Build arguments for `defaultDockerfile` |

Building a project's Dockerfile runs its `RUN` steps on this host's Docker, so with `auto` anyone who can push to a project's default branch chooses what is built here; set `projectDockerfile` to `off` for projects you do not trust.

## Setup

Requires Paseo 0.13 and Docker on the machine that runs the Paseo daemon. The daemon user must be able to run `docker`. The first sandbox builds a runtime image of about 4.3 GB from the official Paseo image plus the Claude Code, Codex, OpenCode and OMP CLIs (OMP alone is about 1.2 GB with its bundled models and bun runtime), so it needs network access and a few minutes.

Credentials are a one-time setup. Save what your agents need under Settings, Sandbox credentials (the Sandboxes screen links there):

- **Claude subscription token** from `claude setup-token`. It is valid for one year, and the plugin warns 30 days before it expires.
- **Anthropic API key**, **OpenAI API key for Codex** and **OpenAI API key for OpenCode**.
- **GitHub token** for cloning private repositories and pushing over https.
- Any other environment variable, such as a different provider's key.

Or share this host's own logins instead of saving values (Settings, Shared logins, off by default). Each switch covers one tool: Claude, Codex, OpenCode, OMP or GitHub.

- **Claude, Codex, OpenCode and OMP** mount the tool's folder from this host read-write, so the sandbox and the host are one client of one login, like two agents on the same machine. A refreshed token is written back where the host sees it. Known hook, skill, plugin, command and settings entries in those folders are mounted read-only. Folders on the list that do not exist yet are created empty on the host first, so the sandbox cannot create one that the host's agent would then load; files that do not exist are not created, so create a settings file first if it should be locked. The list is best effort, not a boundary: a sandbox agent can still read and change the rest of the folder, including history, and on Claude the MCP tokens kept beside the login. Turn it on only for sandboxes you trust. Linux hosts only, and the folder must be owned by uid 1000, the user agents run as inside the sandbox.
- **OMP** shares its agent folder (`PI_CODING_AGENT_DIR`, else `~/.omp/agent`), which holds its stored logins in `agent.db`, its sessions and its config. It is mounted at `/home/paseo/.omp-agent` and the sandbox sets `PI_CODING_AGENT_DIR` to match. Config, MCP, models, hooks, extensions, skills and rules entries are read-only, as a best-effort list. Only the default OMP profile is shared. The sandbox turns the OMP provider on in its own daemon, because Paseo ships it off, so it appears in the agent list of every sandbox. OMP also reads provider keys from the environment, so a saved Anthropic or OpenAI key works there without sharing.
- **GitHub** runs `gh auth token` on this host when a sandbox starts and passes the result as `GITHUB_TOKEN`. It has every scope your `gh` login has. It is read again at each start but is not watched, so after a new `gh auth login`, restart the sandbox.
- While a login is shared, the matching saved values are ignored, because the tool would otherwise prefer them to the shared login: the Claude token and Anthropic key for Claude, the OpenAI key for OpenCode, the Codex API key (signing it in would overwrite the host's `auth.json`) and the GitHub token.
- Folder paths come from the daemon's environment and are fixed when the container is created. After changing `CLAUDE_CONFIG_DIR`, `CODEX_HOME` or `XDG_DATA_HOME` and restarting the daemon, remove and recreate the sandbox. Paths with a comma or quote are refused.

Every sandbox receives the saved values when it starts. Changing a value marks running sandboxes as using older credentials, and Restart applies it without losing project data.

## What it reads, sends and stores

Credentials and sandbox records live in a private file under the daemon's Paseo home, `plugin-data/sandbox/state.json`, readable only by the daemon user. They are never sent to the app, never shown again after saving, and are written only to the sandboxes that start afterwards. The daemon also stores each sandbox's random connection password, as Paseo does for any connected host.

The app reaches a sandbox through Paseo's relay over TLS with end-to-end encryption and that password. The container publishes no ports, mounts only its own volume unless you share a host login, has no Docker socket, drops all but four Linux capabilities and runs agents as a non-root user.

## Limits

- Docker is the only sandbox provider. A container limits what an agent can reach on your machine, but it is not a hard security boundary, and agents inside have outbound network access and the credentials you saved.
- Containers have no CPU, memory or process limits, and the default Docker network lets them reach the host's LAN.
- A saved value is visible to anyone who can run `docker inspect` on the daemon host, and to every process inside that sandbox.
- A ChatGPT, Claude or OpenCode login that rotates tokens must not be copied: two holders of one refresh token can log each other out. Share the host's login with the switches above (one file, one lineage), or sign in inside one sandbox: `docker exec -it -u paseo paseo-sandbox-<id> codex login`. That login persists in that sandbox's volume.
- On macOS Claude keeps its login in the Keychain, not in a folder, so there is nothing to mount.
- The built-in image has no `gh` CLI, so pull request status and creation are unavailable inside a sandbox unless the project's `.paseo.Dockerfile` adds it. Agents can still push with the GitHub token.
- Project images are read from the default branch, not from the branch checked out inside the sandbox. Old project images are not deleted; remove unused `paseo-sandbox-project:*` tags with `docker image rm` or `docker image prune`.
- A rejected or revoked key shows up as an error in the agent's conversation. Only the Claude token has a known lifetime.
- Clients that were already open when a sandbox was removed can keep showing its projects until their cached host data is cleared.
