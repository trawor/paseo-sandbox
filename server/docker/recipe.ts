import { createHash } from "node:crypto";
import type { ImageRecipe } from "../provider";
import { IMAGE_TAG } from "./image";

/** Repository for images built from a project's or the host's own Dockerfile. */
export const PROJECT_IMAGE_REPOSITORY = "paseo-sandbox-project";

/**
 * The tag an image recipe runs as. A built tag is a digest of everything that shapes the build,
 * including the built-in tag it extends, so editing any of it builds (and recreates) once.
 */
export function imageTag(recipe: ImageRecipe): string {
  if (recipe.kind === "builtin") return IMAGE_TAG;
  if (recipe.kind === "image") return recipe.image;
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        recipe.dockerfile,
        Object.entries(recipe.buildArgs).sort(([a], [b]) => a.localeCompare(b)),
        recipe.contextDigest,
        recipe.extendsBuiltin ? IMAGE_TAG : "",
      ]),
    )
    .digest("hex")
    .slice(0, 12);
  return `${PROJECT_IMAGE_REPOSITORY}:${digest}`;
}

/**
 * Cheap checks, run inside a candidate image, for the parts of the runtime contract a failure
 * would otherwise only reveal minutes later as an unhealthy or silent sandbox.
 */
export const CONTRACT_CHECK = [
  'missing=""',
  'uid="$(id -u paseo 2>/dev/null)" || missing="$missing user:paseo"',
  'if [ -n "$uid" ] && [ "$uid" != 1000 ]; then missing="$missing user:paseo-uid-1000(found:$uid)"; fi',
  'for c in paseo git node; do command -v "$c" >/dev/null 2>&1 || missing="$missing $c"; done',
  'agents=""',
  'for c in claude codex opencode omp; do command -v "$c" >/dev/null 2>&1 || agents="$agents $c"; done',
  'echo "missing:$missing"',
  'echo "agents:$agents"',
].join("\n");

export interface ContractReport {
  missing: string[];
  missingAgents: string[];
}

export function parseContractReport(stdout: string): ContractReport {
  const field = (name: string) =>
    stdout
      .split("\n")
      .find((line) => line.startsWith(`${name}:`))
      ?.slice(name.length + 1)
      .split(" ")
      .filter(Boolean) ?? [];
  return { missing: field("missing"), missingAgents: field("agents") };
}
