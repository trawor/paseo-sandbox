import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import {
  Modal,
  ScrollView,
  SettingsAction,
  SettingsCard,
  SettingsInput,
  type SettingsInputHandle,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
} from "@getpaseo/plugin/client/ui";
import { useMemo, useRef, useState } from "react";
import { Text } from "react-native";
import type { Sandbox } from "../shared/sandbox";
import { useCredentials, useSandboxActions, useSandboxes } from "./queries";
import {
  describeSandbox,
  folderName,
  hasModelCredential,
  needsRestart,
  repositoryName,
  sandboxSource,
} from "./view-model";

interface SandboxCardProps {
  hostId: string;
  theme: PluginTheme;
  sandbox: Sandbox;
}

function SandboxCard({ hostId, theme, sandbox }: SandboxCardProps) {
  const actions = useSandboxActions(hostId);
  const [confirming, setConfirming] = useState(false);
  const running = sandbox.runtime === "running";
  const failure = [actions.start, actions.stop, actions.remove].find((action) => action.error);
  const toggle = running ? actions.stop : actions.start;
  const toggleLabel = running ? "Stop" : "Start";
  return (
    <SettingsSection title={sandbox.name}>
      <SettingsCard>
        <SettingsRow
          label={sandboxSource(sandbox)}
          hint={describeSandbox(sandbox)}
          error={failure?.error?.message}
        />
        {needsRestart(sandbox) ? (
          <SettingsAction
            label="Restart"
            hint="Applies saved credentials and reconnects the host. The project data is kept."
            actionLabel={actions.start.isPending ? "Restarting..." : "Restart"}
            disabled={Boolean(sandbox.busy) || actions.start.isPending}
            onPress={() => actions.start.mutate({ id: sandbox.id })}
          />
        ) : null}
        <SettingsAction
          label={toggleLabel}
          hint={running ? "Keeps the project data" : "Starts the sandbox and registers it"}
          actionLabel={toggle.isPending ? `${toggleLabel}...` : toggleLabel}
          disabled={Boolean(sandbox.busy) || toggle.isPending}
          onPress={() => toggle.mutate({ id: sandbox.id })}
        />
        <SettingsAction
          label="Rebuild image"
          hint="Rebuilds the project's .paseo.Dockerfile image without cache (or pulls its image again) and recreates the sandbox. The project data is kept."
          actionLabel="Rebuild"
          disabled={Boolean(sandbox.busy) || actions.start.isPending}
          onPress={() => actions.start.mutate({ id: sandbox.id, rebuild: true })}
        />
        <SettingsAction
          label="Remove"
          hint="Deletes the sandbox and its project data"
          actionLabel="Remove"
          disabled={Boolean(sandbox.busy)}
          onPress={() => setConfirming(true)}
        />
      </SettingsCard>
      <Modal title="Remove sandbox" open={confirming} onOpenChange={setConfirming}>
        <Modal.Content>
          <Text style={{ color: theme.colors.foregroundMuted }}>
            Remove {sandbox.name}? This deletes the container and everything stored in it, including
            the project checkout and any agent logins.
          </Text>
          {actions.remove.error ? (
            <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>
              {actions.remove.error.message}
            </Text>
          ) : null}
          <SettingsCard>
            <SettingsAction
              label="Remove sandbox"
              actionLabel={actions.remove.isPending ? "Removing..." : "Remove"}
              disabled={actions.remove.isPending}
              onPress={() =>
                actions.remove.mutate({ id: sandbox.id }, { onSuccess: () => setConfirming(false) })
              }
            />
            <SettingsAction
              label="Keep the sandbox"
              actionLabel="Cancel"
              onPress={() => {
                actions.remove.reset();
                setConfirming(false);
              }}
            />
          </SettingsCard>
        </Modal.Content>
      </Modal>
    </SettingsSection>
  );
}

type SourceKind = "repo" | "local";

const SOURCE_OPTIONS = [
  { label: "GitHub repository", value: "repo" },
  { label: "Local folder", value: "local" },
] as const satisfies readonly { label: string; value: SourceKind }[];

function CreateSandbox({ hostId }: { hostId: string }) {
  const { create } = useSandboxActions(hostId);
  const nameInput = useRef<SettingsInputHandle>(null);
  const projectInput = useRef<SettingsInputHandle>(null);
  const targetInput = useRef<SettingsInputHandle>(null);
  const [kind, setKind] = useState<SourceKind>("local");
  const [name, setName] = useState("");
  const [project, setProject] = useState("");
  const [target, setTarget] = useState("");
  const local = kind === "local";
  function reset() {
    for (const input of [nameInput, projectInput, targetInput]) input.current?.replaceText("");
    setName("");
    setProject("");
    setTarget("");
  }
  function submit() {
    const source = project.trim();
    const label = name.trim() || (local ? folderName(source) : repositoryName(source));
    create.mutate(
      local
        ? { name: label, localPath: source, ...(target.trim() ? { target: target.trim() } : {}) }
        : { name: label, repoUrl: source },
      { onSuccess: reset },
    );
  }
  return (
    <SettingsSection title="New sandbox">
      <SettingsCard>
        <SettingsSelect
          label="Source"
          hint={
            local
              ? "A folder on the machine that runs Paseo. It is mounted read-write, not copied."
              : "Cloned inside the sandbox from GitHub or any https Git URL."
          }
          value={kind}
          options={SOURCE_OPTIONS}
          onValueChange={(value) => {
            setKind(value);
            setProject("");
            setTarget("");
            create.reset();
          }}
        />
        <SettingsInput
          key={kind}
          ref={projectInput}
          label={local ? "Folder" : "Project"}
          hint={
            local
              ? "Absolute path or ~/..., on the Paseo host. Not / or your home folder itself."
              : "owner/repo on GitHub, or an https URL. It is cloned inside the sandbox."
          }
          placeholder={local ? "~/code/my-project" : "owner/repo"}
          onChangeText={setProject}
          error={create.error?.message}
        />
        {local ? (
          <SettingsInput
            ref={targetInput}
            label="Path in sandbox"
            hint={`Where the folder appears and opens. Defaults to /workspace/${folderName(project) || "<folder name>"}`}
            placeholder="/workspace/my-project"
            onChangeText={setTarget}
          />
        ) : null}
        <SettingsInput
          ref={nameInput}
          label="Name"
          hint={local ? "Defaults to the folder name" : "Defaults to the project name"}
          onChangeText={setName}
        />
        <SettingsAction
          label="Create sandbox"
          hint="Runs the project's workspaces, agents and terminals in their own sandbox"
          actionLabel={create.isPending ? "Creating..." : "Create"}
          disabled={!project.trim() || create.isPending}
          onPress={submit}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

export interface SandboxesScreenProps extends PluginScreenProps {
  openCredentials(): void;
}

export function SandboxesScreen({ theme, layout, host, openCredentials }: SandboxesScreenProps) {
  const sandboxes = useSandboxes(host.id);
  const credentials = useCredentials(host.id);
  const styles = useMemo(() => createStyles(theme, layout.compact), [theme, layout.compact]);
  const runtime = sandboxes.data?.runtime;
  const missingModelCredential =
    credentials.query.data && !hasModelCredential(credentials.query.data.credentials);
  return (
    <ScrollView contentContainerStyle={styles.screen}>
      {runtime && !runtime.available ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {runtime.problem}
        </Text>
      ) : null}
      {sandboxes.error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {sandboxes.error.message}
        </Text>
      ) : null}
      {sandboxes.data?.sandboxes.map((sandbox) => (
        <SandboxCard key={sandbox.id} hostId={host.id} theme={theme} sandbox={sandbox} />
      ))}
      <CreateSandbox hostId={host.id} />
      <SettingsSection title="Credentials">
        <SettingsCard>
          <SettingsAction
            label="Agent and Git credentials"
            hint={
              missingModelCredential
                ? "No model credentials are saved, so agents can only use free models"
                : "Keys and tokens that sandboxes receive when they start"
            }
            actionLabel="Open settings"
            onPress={openCredentials}
          />
        </SettingsCard>
      </SettingsSection>
    </ScrollView>
  );
}

function createStyles(theme: PluginTheme, compact: boolean) {
  return {
    screen: {
      padding: compact ? 16 : 24,
      gap: compact ? 16 : 20,
      backgroundColor: theme.colors.surface0,
    },
    error: { color: theme.colors.statusDanger },
  };
}
