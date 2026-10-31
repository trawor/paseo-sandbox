import { type ExecFileException, execFile } from "node:child_process";

export interface DockerRun {
  stdout: string;
  stderr: string;
}

export interface DockerOptions {
  stdin?: string;
  /** Reaches the CLI process only, so secret values never appear in argv. */
  env?: Readonly<Record<string, string>>;
  timeoutMs?: number;
}

/** The only way the provider reaches Docker, so tests can supply an in-memory one. */
export type DockerCli = (args: readonly string[], options?: DockerOptions) => Promise<DockerRun>;

export class DockerError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
  }
}

const DEFAULT_TIMEOUT_MS = 120_000;

function failureMessage(
  error: ExecFileException,
  stderr: string,
  args: readonly string[],
  timeoutMs: number,
) {
  if (error.code === "ENOENT")
    return "Docker is not installed on the Paseo host, or `docker` is not on its PATH.";
  if (error.killed && error.signal) return `docker ${args[0]} timed out after ${timeoutMs / 1000}s`;
  const missingSource = /bind source path does not exist: (.+)/.exec(stderr);
  if (missingSource)
    return `A mounted folder does not exist on the Docker host: ${missingSource[1]?.trim()}. Docker must see the same path as Paseo; on Docker Desktop, make sure it is under a shared folder (Settings, Resources, File sharing).`;
  // Docker ends many failures with a "Run 'docker run --help'" hint; the reason is above it.
  const reason = stderr
    .trim()
    .split("\n")
    .filter((line) => line.trim() && !/^Run 'docker .*--help'/.test(line.trim()))
    .at(-1);
  return `docker ${args[0]} failed: ${reason || error.message}`;
}

export function execDocker(
  args: readonly string[],
  options: DockerOptions = {},
): Promise<DockerRun> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const { promise, resolve, reject } = Promise.withResolvers<DockerRun>();
  const child = execFile(
    "docker",
    [...args],
    { env: { ...process.env, ...options.env }, maxBuffer: 16 << 20, timeout: timeoutMs },
    (error, stdout, stderr) => {
      if (!error) return resolve({ stdout, stderr });
      reject(new DockerError(failureMessage(error, stderr, args, timeoutMs), stderr));
    },
  );
  // A child that exits before reading its stdin must not take the plugin down with an EPIPE.
  child.stdin?.on("error", () => undefined);
  child.stdin?.end(options.stdin);
  return promise;
}

/** Docker's own "No such container, image or volume" answer, as opposed to a daemon failure. */
export function isAbsent(error: unknown) {
  return (
    error instanceof DockerError && /no such (container|image|volume|object)/i.test(error.stderr)
  );
}
