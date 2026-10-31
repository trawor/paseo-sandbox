import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { execDocker } from "../server/docker/cli";

const originalPath = process.env.PATH;
let bin: string;

/** A `docker` on PATH that fails the way Docker does: the reason, then a help hint. */
async function failingDocker(stderr: string) {
  await writeFile(join(bin, "stderr.txt"), `${stderr}\n`);
  await writeFile(
    join(bin, "docker"),
    `#!/bin/sh\ncat >/dev/null\ncat ${join(bin, "stderr.txt")} >&2\nexit 125\n`,
  );
  await chmod(join(bin, "docker"), 0o755);
}

beforeEach(async () => {
  bin = await mkdtemp(join(tmpdir(), "sandbox-docker-cli-"));
  process.env.PATH = `${bin}:${originalPath}`;
});
afterEach(() => {
  process.env.PATH = originalPath;
});

describe("docker failures", () => {
  test("a missing bind source is explained with the path", async () => {
    await failingDocker(
      "docker: Error response from daemon: invalid mount config for type \"bind\": bind source path does not exist: /Users/t/app\n\nRun 'docker run --help' for more information",
    );
    await expect(execDocker(["run", "x"])).rejects.toThrow(
      "A mounted folder does not exist on the Docker host: /Users/t/app.",
    );
  });

  test("the reason is kept instead of Docker's help hint", async () => {
    await failingDocker(
      "docker: Error response from daemon: Conflict. The container name is in use.\n\nRun 'docker run --help' for more information",
    );
    await expect(execDocker(["run", "x"])).rejects.toThrow(
      "docker run failed: docker: Error response from daemon: Conflict. The container name is in use.",
    );
  });
});
