import { dirname, join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { savedCredentials } from "./server/credentials";
import { execDocker } from "./server/docker/cli";
import { createDockerProvider } from "./server/docker/provider";
import { hostGithubToken, hostLoginMounts } from "./server/host-logins";
import { sandboxHosts } from "./server/hosts";
import { openProjectCheckout } from "./server/project-files";
import { loadPluginImageConfig, resolveImage } from "./server/project-image";
import { parseRepository } from "./server/repository";
import { createSandboxService, type ProjectImages } from "./server/service";
import { defaultStatePath, Store } from "./server/store";
import {
  listCredentials,
  listHostLogins,
  removeCredential,
  setCredential,
  setHostLogin,
} from "./shared/credentials";
import {
  createSandbox,
  listSandboxes,
  removeSandbox,
  startSandbox,
  stopSandbox,
} from "./shared/sandbox";

/** Project `.paseo/sandbox.json` / `.paseo.Dockerfile`, then host defaults, then built-in. */
function projectImages(configPath: string): ProjectImages {
  return {
    async resolve({ repoUrl, githubToken, rebuild }) {
      return resolveImage({
        // Read on every start, so a changed setting applies without restarting Paseo.
        config: await loadPluginImageConfig(configPath),
        openProject: () => openProjectCheckout(parseRepository(repoUrl).url, { githubToken }),
        rebuild,
      });
    },
  };
}

export default function contribute(server: PluginServerContext) {
  const statePath = defaultStatePath();
  const store = new Store(statePath);
  const sandboxes = createSandboxService(
    createDockerProvider(execDocker),
    store,
    {
      mounts: (enabled) => hostLoginMounts({ enabled }),
      githubToken: () => hostGithubToken(),
    },
    projectImages(join(dirname(statePath), "config.json")),
  );
  const credentials = savedCredentials(store);

  server.handle(listSandboxes, (_input, { paseo }) => sandboxes.list(sandboxHosts(paseo.hosts)));
  server.handle(createSandbox, (input, { paseo }) =>
    sandboxes.create(sandboxHosts(paseo.hosts), input),
  );
  server.handle(startSandbox, async ({ id, rebuild }, { paseo }) => {
    await sandboxes.start(sandboxHosts(paseo.hosts), id, { rebuild });
    return {};
  });
  server.handle(stopSandbox, async ({ id }) => {
    await sandboxes.stop(id);
    return {};
  });
  server.handle(removeSandbox, async ({ id }, { paseo }) => {
    await sandboxes.remove(sandboxHosts(paseo.hosts), id);
    return {};
  });
  server.handle(listCredentials, async () => ({ credentials: await credentials.list() }));
  server.handle(setCredential, async ({ name, value }) => ({
    credentials: await credentials.save(name, value),
  }));
  server.handle(removeCredential, async ({ name }) => ({
    credentials: await credentials.remove(name),
  }));
  server.handle(listHostLogins, async () => ({ hostLogins: await credentials.hostLogins() }));
  server.handle(setHostLogin, async ({ id, enabled }) => ({
    hostLogins: await credentials.setHostLogin(id, enabled),
  }));
  return () => {};
}
