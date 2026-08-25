import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const EditorLaunchStyle = Schema.Literals(["direct-path", "goto", "line-column"]);
export type EditorLaunchStyle = typeof EditorLaunchStyle.Type;

type EditorDefinition = {
  readonly id: string;
  readonly label: string;
  readonly commands: readonly [string, ...string[]] | null;
  readonly baseArgs?: readonly string[];
  readonly launchStyle: EditorLaunchStyle;
  readonly remoteLaunch?:
    | { readonly kind: "vscode-remote"; readonly scheme: string }
    | { readonly kind: "zed-ssh"; readonly scheme: "zed" };
};

export const EDITORS = [
  {
    id: "cursor",
    label: "Cursor",
    commands: ["cursor"],
    launchStyle: "goto",
    remoteLaunch: { kind: "vscode-remote", scheme: "cursor" },
  },
  { id: "trae", label: "Trae", commands: ["trae"], launchStyle: "goto" },
  { id: "kiro", label: "Kiro", commands: ["kiro"], baseArgs: ["ide"], launchStyle: "goto" },
  {
    id: "vscode",
    label: "VS Code",
    commands: ["code"],
    launchStyle: "goto",
    remoteLaunch: { kind: "vscode-remote", scheme: "vscode" },
  },
  {
    id: "vscode-insiders",
    label: "VS Code Insiders",
    commands: ["code-insiders"],
    launchStyle: "goto",
    remoteLaunch: { kind: "vscode-remote", scheme: "vscode-insiders" },
  },
  {
    id: "vscodium",
    label: "VSCodium",
    commands: ["codium"],
    launchStyle: "goto",
    remoteLaunch: { kind: "vscode-remote", scheme: "vscodium" },
  },
  {
    id: "zed",
    label: "Zed",
    commands: ["zed", "zeditor"],
    launchStyle: "direct-path",
    remoteLaunch: { kind: "zed-ssh", scheme: "zed" },
  },
  { id: "antigravity", label: "Antigravity", commands: ["agy"], launchStyle: "goto" },
  { id: "idea", label: "IntelliJ IDEA", commands: ["idea"], launchStyle: "line-column" },
  { id: "aqua", label: "Aqua", commands: ["aqua"], launchStyle: "line-column" },
  { id: "clion", label: "CLion", commands: ["clion"], launchStyle: "line-column" },
  { id: "datagrip", label: "DataGrip", commands: ["datagrip"], launchStyle: "line-column" },
  { id: "dataspell", label: "DataSpell", commands: ["dataspell"], launchStyle: "line-column" },
  { id: "goland", label: "GoLand", commands: ["goland"], launchStyle: "line-column" },
  { id: "phpstorm", label: "PhpStorm", commands: ["phpstorm"], launchStyle: "line-column" },
  { id: "pycharm", label: "PyCharm", commands: ["pycharm"], launchStyle: "line-column" },
  { id: "rider", label: "Rider", commands: ["rider"], launchStyle: "line-column" },
  { id: "rubymine", label: "RubyMine", commands: ["rubymine"], launchStyle: "line-column" },
  { id: "rustrover", label: "RustRover", commands: ["rustrover"], launchStyle: "line-column" },
  { id: "webstorm", label: "WebStorm", commands: ["webstorm"], launchStyle: "line-column" },
  { id: "file-manager", label: "File Manager", commands: null, launchStyle: "direct-path" },
] as const satisfies ReadonlyArray<EditorDefinition>;

export const EditorId = Schema.Literals(EDITORS.map((e) => e.id));
export type EditorId = typeof EditorId.Type;

export const LaunchEditorInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  editor: EditorId,
});
export type LaunchEditorInput = typeof LaunchEditorInput.Type;

const remoteLaunchOf = (editor: EditorDefinition) => editor.remoteLaunch;

/** Editors that can open a workspace on an SSH host from the viewing machine. */
export const REMOTE_CAPABLE_EDITOR_IDS: ReadonlyArray<EditorId> = EDITORS.flatMap((editor) =>
  remoteLaunchOf(editor) !== undefined ? [editor.id] : [],
);

const remoteLaunchForEditor = (id: EditorId) => {
  const editor = EDITORS.find((candidate) => candidate.id === id);
  return editor === undefined ? undefined : remoteLaunchOf(editor);
};

const encodeRemotePath = (absolutePath: string) => {
  const posixPath = absolutePath.replaceAll("\\", "/");
  const rootedPath = posixPath.startsWith("/") ? posixPath : `/${posixPath}`;
  return rootedPath.split("/").map(encodeURIComponent).join("/");
};

/**
 * Builds the editor-specific deep link that opens `absolutePath` on `host`
 * over SSH. Returns undefined for editors without remote support.
 */
export const buildRemoteOpenUrl = (input: {
  readonly editor: EditorId;
  readonly host: string;
  readonly absolutePath: string;
}): string | undefined => {
  const remoteLaunch = remoteLaunchForEditor(input.editor);
  if (remoteLaunch === undefined) {
    return undefined;
  }
  const encodedHost = encodeURIComponent(input.host);
  const encodedPath = encodeRemotePath(input.absolutePath);

  switch (remoteLaunch.kind) {
    case "vscode-remote":
      return `${remoteLaunch.scheme}://vscode-remote/ssh-remote+${encodedHost}${encodedPath}`;
    case "zed-ssh":
      return `${remoteLaunch.scheme}://ssh/${encodedHost}${encodedPath}`;
  }
};

const remoteLaunchForProtocol = (protocol: string) => {
  const editor = EDITORS.find((candidate) => {
    const remoteLaunch = remoteLaunchOf(candidate);
    return remoteLaunch !== undefined && `${remoteLaunch.scheme}:` === protocol;
  });
  return editor === undefined ? undefined : remoteLaunchOf(editor);
};

/** Accepts only remote editor URLs whose shape T3 Code itself can build. */
export const isRemoteOpenUrl = (url: URL): boolean => {
  if (url.username.length > 0 || url.password.length > 0) {
    return false;
  }

  const remoteLaunch = remoteLaunchForProtocol(url.protocol);
  if (remoteLaunch === undefined) {
    return false;
  }

  switch (remoteLaunch.kind) {
    case "vscode-remote":
      return (
        url.host === "vscode-remote" &&
        url.pathname.startsWith("/ssh-remote+") &&
        url.pathname.length > "/ssh-remote+".length
      );
    case "zed-ssh":
      return (
        url.host === "ssh" &&
        url.pathname.indexOf("/", 1) > 1 &&
        url.search.length === 0 &&
        url.hash.length === 0
      );
  }
};

/**
 * SSH hostnames an environment advertises for remote open links. Reachability
 * is client-side; the server only advertises names that resolve to itself and
 * gates them on a local sshd listen check. Ordered most-reachable first
 * (tailnet MagicDNS name, then mDNS `<hostname>.local`).
 */
export const RemoteOpenTargetKind = Schema.Literals(["tailscale", "mdns"]);
export type RemoteOpenTargetKind = typeof RemoteOpenTargetKind.Type;

export const RemoteOpenTarget = Schema.Struct({
  kind: RemoteOpenTargetKind,
  host: TrimmedNonEmptyString,
});
export type RemoteOpenTarget = typeof RemoteOpenTarget.Type;

export class ExternalLauncherUnknownEditorError extends Schema.TaggedErrorClass<ExternalLauncherUnknownEditorError>()(
  "ExternalLauncherUnknownEditorError",
  {
    editor: Schema.String,
  },
) {
  override get message(): string {
    return `Unknown editor: ${this.editor}`;
  }
}

export class ExternalLauncherUnsupportedEditorError extends Schema.TaggedErrorClass<ExternalLauncherUnsupportedEditorError>()(
  "ExternalLauncherUnsupportedEditorError",
  {
    editor: EditorId,
  },
) {
  override get message(): string {
    return `Unsupported editor: ${this.editor}`;
  }
}

export class ExternalLauncherCommandNotFoundError extends Schema.TaggedErrorClass<ExternalLauncherCommandNotFoundError>()(
  "ExternalLauncherCommandNotFoundError",
  {
    editor: EditorId,
    command: Schema.String,
  },
) {
  override get message(): string {
    return `Editor command not found: ${this.command}`;
  }
}

const ExternalLauncherSpawnFields = {
  command: Schema.String,
  args: Schema.Array(Schema.String),
  cause: Schema.Defect(),
};

export class ExternalLauncherBrowserSpawnError extends Schema.TaggedErrorClass<ExternalLauncherBrowserSpawnError>()(
  "ExternalLauncherBrowserSpawnError",
  {
    ...ExternalLauncherSpawnFields,
    target: Schema.String,
  },
) {
  override get message(): string {
    return `Failed to launch browser target '${this.target}' with '${[this.command, ...this.args].join(" ")}'`;
  }
}

export class ExternalLauncherEditorSpawnError extends Schema.TaggedErrorClass<ExternalLauncherEditorSpawnError>()(
  "ExternalLauncherEditorSpawnError",
  {
    ...ExternalLauncherSpawnFields,
    editor: EditorId,
    target: Schema.String,
  },
) {
  override get message(): string {
    return `Failed to launch '${this.target}' in ${this.editor} with '${[this.command, ...this.args].join(" ")}'`;
  }
}

export const ExternalLauncherError = Schema.Union([
  ExternalLauncherUnknownEditorError,
  ExternalLauncherUnsupportedEditorError,
  ExternalLauncherCommandNotFoundError,
  ExternalLauncherBrowserSpawnError,
  ExternalLauncherEditorSpawnError,
]);
export type ExternalLauncherError = typeof ExternalLauncherError.Type;

export const isExternalLauncherError = Schema.is(ExternalLauncherError);
