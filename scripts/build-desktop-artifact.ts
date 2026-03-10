#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";

import rootPackageJson from "../package.json" with { type: "json" };
import desktopPackageJson from "../apps/desktop/package.json" with { type: "json" };
import serverPackageJson from "../apps/server/package.json" with { type: "json" };

import { BRAND_ASSET_PATHS } from "./lib/brand-assets.ts";
import { resolveCatalogDependencies } from "./lib/resolve-catalog.ts";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Config, Data, Effect, FileSystem, Layer, Logger, Option, Path, Schema } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const BuildPlatform = Schema.Literals(["mac", "linux", "win"]);
const BuildArch = Schema.Literals(["arm64", "x64", "universal"]);

const RepoRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("..", import.meta.url))),
);
const ProductionMacIconSource = Effect.zipWith(
  RepoRoot,
  Effect.service(Path.Path),
  (repoRoot, path) => path.join(repoRoot, BRAND_ASSET_PATHS.productionMacIconPng),
);
const ProductionLinuxIconSource = Effect.zipWith(
  RepoRoot,
  Effect.service(Path.Path),
  (repoRoot, path) => path.join(repoRoot, BRAND_ASSET_PATHS.productionLinuxIconPng),
);
const ProductionWindowsIconSource = Effect.zipWith(
  RepoRoot,
  Effect.service(Path.Path),
  (repoRoot, path) => path.join(repoRoot, BRAND_ASSET_PATHS.productionWindowsIconIco),
);
const encodeJsonString = Schema.encodeEffect(Schema.UnknownFromJsonString);

interface PlatformConfig {
  readonly cliFlag: "--mac" | "--linux" | "--win";
  readonly defaultTarget: string;
  readonly archChoices: ReadonlyArray<typeof BuildArch.Type>;
}

const PLATFORM_CONFIG: Record<typeof BuildPlatform.Type, PlatformConfig> = {
  mac: {
    cliFlag: "--mac",
    defaultTarget: "dmg",
    archChoices: ["arm64", "x64", "universal"],
  },
  linux: {
    cliFlag: "--linux",
    defaultTarget: "AppImage",
    archChoices: ["x64", "arm64"],
  },
  win: {
    cliFlag: "--win",
    defaultTarget: "nsis",
    archChoices: ["x64", "arm64"],
  },
};

interface BuildCliInput {
  readonly platform: Option.Option<typeof BuildPlatform.Type>;
  readonly target: Option.Option<string>;
  readonly arch: Option.Option<typeof BuildArch.Type>;
  readonly buildVersion: Option.Option<string>;
  readonly outputDir: Option.Option<string>;
  readonly injectAppImageUpdateMetadata: Option.Option<boolean>;
  readonly appImageUpdateRepository: Option.Option<string>;
  readonly appImageUpdateInformation: Option.Option<string>;
  readonly skipAppImageAppstreamValidation: Option.Option<boolean>;
  readonly skipBuild: Option.Option<boolean>;
  readonly keepStage: Option.Option<boolean>;
  readonly signed: Option.Option<boolean>;
  readonly verbose: Option.Option<boolean>;
}

function detectHostBuildPlatform(hostPlatform: string): typeof BuildPlatform.Type | undefined {
  if (hostPlatform === "darwin") return "mac";
  if (hostPlatform === "linux") return "linux";
  if (hostPlatform === "win32") return "win";
  return undefined;
}

function getDefaultArch(platform: typeof BuildPlatform.Type): typeof BuildArch.Type {
  const config = PLATFORM_CONFIG[platform];
  if (!config) {
    return "x64";
  }

  if (process.arch === "arm64" && config.archChoices.includes("arm64")) {
    return "arm64";
  }
  if (process.arch === "x64" && config.archChoices.includes("x64")) {
    return "x64";
  }

  return config.archChoices[0] ?? "x64";
}

class BuildScriptError extends Data.TaggedError("BuildScriptError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

function resolveGitCommitHash(repoRoot: string): string {
  const result = spawnSync("git", ["rev-parse", "--short=12", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    return "unknown";
  }
  const hash = result.stdout.trim();
  if (!/^[0-9a-f]{7,40}$/i.test(hash)) {
    return "unknown";
  }
  return hash.toLowerCase();
}

function resolvePythonForNodeGyp(): string | undefined {
  const configured = process.env.npm_config_python ?? process.env.PYTHON;
  if (configured && existsSync(configured)) {
    return configured;
  }

  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      for (const version of ["Python313", "Python312", "Python311", "Python310"]) {
        const candidate = join(localAppData, "Programs", "Python", version, "python.exe");
        if (existsSync(candidate)) {
          return candidate;
        }
      }
    }
  }

  const probe = spawnSync("python", ["-c", "import sys;print(sys.executable)"], {
    encoding: "utf8",
  });
  if (probe.status !== 0) {
    return undefined;
  }

  const executable = probe.stdout.trim();
  if (!executable || !existsSync(executable)) {
    return undefined;
  }

  return executable;
}

interface ResolvedBuildOptions {
  readonly platform: typeof BuildPlatform.Type;
  readonly target: string;
  readonly arch: typeof BuildArch.Type;
  readonly version: string | undefined;
  readonly outputDir: string;
  readonly injectAppImageUpdateMetadata: boolean;
  readonly appImageUpdateRepository: string | undefined;
  readonly appImageUpdateInformation: string | undefined;
  readonly skipAppImageAppstreamValidation: boolean;
  readonly skipBuild: boolean;
  readonly keepStage: boolean;
  readonly signed: boolean;
  readonly verbose: boolean;
}

interface AppImageUpdateRepository {
  readonly owner: string;
  readonly repository: string;
}

interface StagePackageJson {
  readonly name: string;
  readonly version: string;
  readonly buildVersion: string;
  readonly t3codeCommitHash: string;
  readonly private: true;
  readonly description: string;
  readonly author: string;
  readonly main: string;
  readonly build: Record<string, unknown>;
  readonly dependencies: Record<string, unknown>;
  readonly devDependencies: {
    readonly electron: string;
  };
}

const AzureTrustedSigningOptionsConfig = Config.all({
  publisherName: Config.string("AZURE_TRUSTED_SIGNING_PUBLISHER_NAME"),
  endpoint: Config.string("AZURE_TRUSTED_SIGNING_ENDPOINT"),
  certificateProfileName: Config.string("AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME"),
  codeSigningAccountName: Config.string("AZURE_TRUSTED_SIGNING_ACCOUNT_NAME"),
  fileDigest: Config.string("AZURE_TRUSTED_SIGNING_FILE_DIGEST").pipe(Config.withDefault("SHA256")),
  timestampDigest: Config.string("AZURE_TRUSTED_SIGNING_TIMESTAMP_DIGEST").pipe(
    Config.withDefault("SHA256"),
  ),
  timestampRfc3161: Config.string("AZURE_TRUSTED_SIGNING_TIMESTAMP_RFC3161").pipe(
    Config.withDefault("http://timestamp.acs.microsoft.com"),
  ),
});

const BuildEnvConfig = Config.all({
  platform: Config.schema(BuildPlatform, "T3CODE_DESKTOP_PLATFORM").pipe(Config.option),
  target: Config.string("T3CODE_DESKTOP_TARGET").pipe(Config.option),
  arch: Config.schema(BuildArch, "T3CODE_DESKTOP_ARCH").pipe(Config.option),
  version: Config.string("T3CODE_DESKTOP_VERSION").pipe(Config.option),
  outputDir: Config.string("T3CODE_DESKTOP_OUTPUT_DIR").pipe(Config.option),
  injectAppImageUpdateMetadata: Config.boolean(
    "T3CODE_DESKTOP_INJECT_APPIMAGE_UPDATE_METADATA",
  ).pipe(Config.withDefault(false)),
  appImageUpdateRepository: Config.string("T3CODE_DESKTOP_APPIMAGE_UPDATE_REPOSITORY").pipe(
    Config.option,
  ),
  appImageUpdateInformation: Config.string("T3CODE_DESKTOP_APPIMAGE_UPDATE_INFORMATION").pipe(
    Config.option,
  ),
  skipAppImageAppstreamValidation: Config.boolean(
    "T3CODE_DESKTOP_SKIP_APPIMAGE_APPSTREAM_VALIDATION",
  ).pipe(Config.withDefault(false)),
  skipBuild: Config.boolean("T3CODE_DESKTOP_SKIP_BUILD").pipe(Config.withDefault(false)),
  keepStage: Config.boolean("T3CODE_DESKTOP_KEEP_STAGE").pipe(Config.withDefault(false)),
  signed: Config.boolean("T3CODE_DESKTOP_SIGNED").pipe(Config.withDefault(false)),
  verbose: Config.boolean("T3CODE_DESKTOP_VERBOSE").pipe(Config.withDefault(false)),
});

const resolveAppImageUpdateRepository = (
  repository: string | undefined,
): AppImageUpdateRepository | undefined => {
  if (!repository) {
    return undefined;
  }

  const [owner, repo, ...extra] = repository.trim().split("/");
  if (!owner || !repo || extra.length > 0) {
    return undefined;
  }

  return { owner, repository: repo };
};

const resolveAppImageUpdateRepositoryFromRemoteUrl = (remoteUrl: string): string | undefined => {
  const normalized = remoteUrl.trim();
  if (!normalized) {
    return undefined;
  }

  const normalizedRemote = normalized
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/^ssh:\/\/git@github\.com\//, "https://github.com/");

  if (
    !normalizedRemote.startsWith("https://github.com/") &&
    !normalizedRemote.startsWith("http://github.com/")
  ) {
    return undefined;
  }

  const path =
    normalizedRemote.replace(/^https?:\/\/(?:www\.)?github\.com\//, "").split(/[?#]/, 1)[0] ?? "";
  const [owner, repository, ...remaining] = path
    .replace(/\.git$/, "")
    .split("/")
    .filter((entry) => entry.length > 0);

  if (!owner || !repository || remaining.length > 0) {
    return undefined;
  }

  return `${owner}/${repository}`;
};

const resolveAppImageUpdateRepositoryFromGit = (repoRoot: string): string | undefined => {
  const result = spawnSync("git", ["-C", repoRoot, "remote", "get-url", "origin"], {
    encoding: "utf8",
  });

  if (result.status !== 0) {
    return undefined;
  }

  return resolveAppImageUpdateRepositoryFromRemoteUrl(result.stdout);
};

const APPIMAGE_APPDATA_PATH =
  "apps/desktop/resources/usr/share/metainfo/t3-code-desktop.appdata.xml";
const APPIMAGE_APPDATA_RELATIVE_TARGET = "usr/share/metainfo/t3-code-desktop.appdata.xml";
const APPIMAGE_APPDATA_VERSION_TOKEN = "__T3CODE_APP_VERSION__";
const APPIMAGE_APPDATA_RELEASE_DATE_TOKEN = "__T3CODE_RELEASE_DATE__";
const LINUX_EXECUTABLE_NAME = "t3-code-desktop";

export function createLinuxDesktopEntry(displayName: string): Record<string, string> {
  return {
    Name: displayName,
    Icon: LINUX_EXECUTABLE_NAME,
    StartupWMClass: LINUX_EXECUTABLE_NAME,
  };
}

export function resolveAppImageReleaseDate(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export function renderAppImageAppData(
  template: string,
  version: string,
  releaseDate: string,
): string {
  if (
    !template.includes(APPIMAGE_APPDATA_VERSION_TOKEN) ||
    !template.includes(APPIMAGE_APPDATA_RELEASE_DATE_TOKEN)
  ) {
    throw new Error("AppImage AppData template is missing required placeholders.");
  }

  const rendered = template
    .replaceAll(APPIMAGE_APPDATA_VERSION_TOKEN, version)
    .replaceAll(APPIMAGE_APPDATA_RELEASE_DATE_TOKEN, releaseDate);

  if (
    rendered.includes(APPIMAGE_APPDATA_VERSION_TOKEN) ||
    rendered.includes(APPIMAGE_APPDATA_RELEASE_DATE_TOKEN)
  ) {
    throw new Error("Failed to replace AppImage AppData template placeholders.");
  }

  return rendered;
}

const resolveAppImageArchToken = (appImagePath: string, arch: string): string => {
  const fileName = basename(appImagePath);
  const appImageArchMatch = fileName.match(/-(x86_64|x64|aarch64|arm64)\.AppImage$/);
  if (appImageArchMatch?.[1]) {
    return appImageArchMatch[1];
  }

  return arch;
};

export const resolveAppImageUpdateInformation = (
  appImagePath: string,
  appImageUpdateRepository: string | undefined,
  appImageUpdateInformation: string | undefined,
  arch: string,
): string | undefined => {
  const explicit = appImageUpdateInformation?.trim();
  if (explicit) {
    return explicit;
  }

  const repository = resolveAppImageUpdateRepository(appImageUpdateRepository);
  if (!repository) {
    return undefined;
  }

  const normalizedArch = resolveAppImageArchToken(appImagePath, arch);
  const fileName = basename(appImagePath);
  const pattern = fileName.startsWith("T3-Code-")
    ? `T3-Code-*-${normalizedArch}.AppImage.zsync`
    : `*-${normalizedArch}.AppImage.zsync`;

  return `gh-releases-zsync|${repository.owner}|${repository.repository}|latest|${pattern}`;
};

const runCommandSync = Effect.fn("runCommandSync")(function* (
  command: string,
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly verbose: boolean;
    readonly description: string;
  },
) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: ["ignore", options.verbose ? "inherit" : "ignore", "inherit"],
  });

  if (result.error) {
    const error = result.error as NodeJS.ErrnoException;
    if (error.code === "ENOENT") {
      return yield* new BuildScriptError({
        message: `${options.description}: command '${command}' was not found.`,
      });
    }
    return yield* new BuildScriptError({
      message: `${options.description}: ${error.message}`,
      cause: error,
    });
  }

  if (result.status !== 0) {
    return yield* new BuildScriptError({
      message: `${options.description}: command '${command}' exited with non-zero code (${result.status}).`,
      cause: result,
    });
  }
});

const injectAppImageUpdateMetadata = Effect.fn("injectAppImageUpdateMetadata")(function* (
  appImagePath: string,
  options: {
    readonly appImageUpdateRepository: string | undefined;
    readonly appImageUpdateInformation: string | undefined;
    readonly arch: typeof BuildArch.Type;
    readonly verbose: boolean;
    readonly appImageAppDataPath: string;
    readonly skipAppstreamValidation: boolean;
  },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const appImageUpdateInfo = resolveAppImageUpdateInformation(
    appImagePath,
    options.appImageUpdateRepository,
    options.appImageUpdateInformation,
    options.arch,
  );
  if (!appImageUpdateInfo) {
    return yield* new BuildScriptError({
      message:
        "AppImage update injection is enabled, but no repository or explicit update information was provided.\n" +
        "Set --appimage-update-repository, --appimage-update-information,\n" +
        "or T3CODE_DESKTOP_APPIMAGE_UPDATE_REPOSITORY / T3CODE_DESKTOP_APPIMAGE_UPDATE_INFORMATION.",
    });
  }

  const workDir = yield* fs.makeTempDirectoryScoped({
    prefix: "t3code-appimage-update-",
  });
  const appImageExtractionPath = path.join(workDir, "squashfs-root");
  const repackedAppImage = path.join(workDir, basename(appImagePath));
  const repackedZsync = `${repackedAppImage}.zsync`;
  const outputZsync = `${appImagePath}.zsync`;
  const extractedAppDataPath = path.join(
    appImageExtractionPath,
    "usr",
    "share",
    "metainfo",
    "t3-code-desktop.appdata.xml",
  );

  yield* runCommandSync("chmod", ["+x", appImagePath], {
    cwd: workDir,
    verbose: options.verbose,
    description: `Making AppImage executable ${basename(appImagePath)}`,
  });

  yield* runCommandSync(appImagePath, ["--appimage-extract"], {
    cwd: workDir,
    verbose: options.verbose,
    description: `Extracting AppImage ${basename(appImagePath)}`,
  });

  if (!(yield* fs.exists(appImageExtractionPath))) {
    return yield* new BuildScriptError({
      message: `AppImage extraction failed for ${appImagePath}; expected ${appImageExtractionPath}.`,
    });
  }

  yield* fs.makeDirectory(path.dirname(extractedAppDataPath), { recursive: true });
  if (!(yield* fs.exists(options.appImageAppDataPath))) {
    return yield* new BuildScriptError({
      message: `Missing AppData metadata source at ${options.appImageAppDataPath}.`,
    });
  }
  yield* fs.copyFile(options.appImageAppDataPath, extractedAppDataPath);

  const appImageToolArgs = ["-u", appImageUpdateInfo, appImageExtractionPath, repackedAppImage];
  if (options.skipAppstreamValidation) {
    appImageToolArgs.unshift("-n");
  }

  yield* runCommandSync("appimagetool", appImageToolArgs, {
    cwd: workDir,
    verbose: options.verbose,
    description: `Repacking AppImage ${basename(appImagePath)} with update metadata`,
  });

  if (!(yield* fs.exists(repackedAppImage))) {
    return yield* new BuildScriptError({
      message: `Failed to rebuild AppImage for ${appImagePath}; expected ${repackedAppImage}.`,
    });
  }

  yield* fs.remove(appImagePath).pipe(Effect.catch(() => Effect.void));
  yield* fs.copyFile(repackedAppImage, appImagePath);

  const writtenArtifacts = [appImagePath];
  if (yield* fs.exists(repackedZsync)) {
    yield* fs.remove(outputZsync).pipe(Effect.catch(() => Effect.void));
    yield* fs.copyFile(repackedZsync, outputZsync);
    writtenArtifacts.push(outputZsync);
  }

  return writtenArtifacts;
});

const writeAppImageAppData = Effect.fn("writeAppImageAppData")(function* (
  templatePath: string,
  targetPath: string,
  version: string,
  releaseDate: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  if (!(yield* fs.exists(templatePath))) {
    return yield* new BuildScriptError({
      message: `Missing AppData metadata template at ${templatePath}.`,
    });
  }

  const template = yield* fs.readFileString(templatePath);
  const rendered = yield* Effect.try({
    try: () => renderAppImageAppData(template, version, releaseDate),
    catch: (cause) =>
      new BuildScriptError({
        message: `Could not render AppData metadata from ${templatePath}.`,
        cause,
      }),
  });

  yield* fs.makeDirectory(path.dirname(targetPath), { recursive: true });
  yield* fs.writeFileString(targetPath, rendered);
});

const resolveBooleanFlag = (flag: Option.Option<boolean>, envValue: boolean) =>
  Option.getOrElse(Option.filter(flag, Boolean), () => envValue);
const mergeOptions = <A>(a: Option.Option<A>, b: Option.Option<A>, defaultValue: A) =>
  Option.getOrElse(a, () => Option.getOrElse(b, () => defaultValue));

const resolveBuildOptions = Effect.fn("resolveBuildOptions")(function* (input: BuildCliInput) {
  const path = yield* Path.Path;
  const repoRoot = yield* RepoRoot;
  const env = yield* BuildEnvConfig.asEffect();

  const platform = mergeOptions(
    input.platform,
    env.platform,
    detectHostBuildPlatform(process.platform),
  );

  if (!platform) {
    return yield* new BuildScriptError({
      message: `Unsupported host platform '${process.platform}'.`,
    });
  }

  const target = mergeOptions(input.target, env.target, PLATFORM_CONFIG[platform].defaultTarget);
  const arch = mergeOptions(input.arch, env.arch, getDefaultArch(platform));
  const version = mergeOptions(input.buildVersion, env.version, undefined);
  const outputDir = path.resolve(repoRoot, mergeOptions(input.outputDir, env.outputDir, "release"));
  const injectAppImageUpdateMetadata = resolveBooleanFlag(
    input.injectAppImageUpdateMetadata,
    env.injectAppImageUpdateMetadata,
  );
  const appImageUpdateRepository = mergeOptions(
    input.appImageUpdateRepository,
    env.appImageUpdateRepository,
    process.env.GITHUB_REPOSITORY?.trim() ?? resolveAppImageUpdateRepositoryFromGit(repoRoot),
  );
  const appImageUpdateInformation = mergeOptions(
    input.appImageUpdateInformation,
    env.appImageUpdateInformation,
    undefined,
  );
  const skipAppImageAppstreamValidation = resolveBooleanFlag(
    input.skipAppImageAppstreamValidation,
    env.skipAppImageAppstreamValidation,
  );

  const skipBuild = resolveBooleanFlag(input.skipBuild, env.skipBuild);
  const keepStage = resolveBooleanFlag(input.keepStage, env.keepStage);
  const signed = resolveBooleanFlag(input.signed, env.signed);
  const verbose = resolveBooleanFlag(input.verbose, env.verbose);

  return {
    platform,
    target,
    arch,
    version,
    outputDir,
    injectAppImageUpdateMetadata,
    appImageUpdateRepository,
    appImageUpdateInformation,
    skipAppImageAppstreamValidation,
    skipBuild,
    keepStage,
    signed,
    verbose,
  } satisfies ResolvedBuildOptions;
});

const commandOutputOptions = (verbose: boolean) =>
  ({
    stdout: verbose ? "inherit" : "ignore",
    stderr: "inherit",
  }) as const;

const runCommand = Effect.fn("runCommand")(function* (command: ChildProcess.Command) {
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* commandSpawner.spawn(command);
  const exitCode = yield* child.exitCode;

  if (exitCode !== 0) {
    return yield* new BuildScriptError({
      message: `Command exited with non-zero exit code (${exitCode})`,
    });
  }
});

function generateMacIconSet(
  sourcePng: string,
  targetIcns: string,
  tmpRoot: string,
  path: Path.Path,
  verbose: boolean,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const iconsetDir = path.join(tmpRoot, "icon.iconset");
    yield* fs.makeDirectory(iconsetDir, { recursive: true });

    const iconSizes = [16, 32, 128, 256, 512] as const;
    for (const size of iconSizes) {
      yield* runCommand(
        ChildProcess.make({
          ...commandOutputOptions(verbose),
        })`sips -z ${size} ${size} ${sourcePng} --out ${path.join(iconsetDir, `icon_${size}x${size}.png`)}`,
      );

      const retinaSize = size * 2;
      yield* runCommand(
        ChildProcess.make({
          ...commandOutputOptions(verbose),
        })`sips -z ${retinaSize} ${retinaSize} ${sourcePng} --out ${path.join(iconsetDir, `icon_${size}x${size}@2x.png`)}`,
      );
    }

    yield* runCommand(
      ChildProcess.make({
        ...commandOutputOptions(verbose),
      })`iconutil -c icns ${iconsetDir} -o ${targetIcns}`,
    );
  });
}

function stageMacIcons(stageResourcesDir: string, verbose: boolean) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const iconSource = yield* ProductionMacIconSource;
    if (!(yield* fs.exists(iconSource))) {
      return yield* new BuildScriptError({
        message: `Production icon source is missing at ${iconSource}`,
      });
    }

    const tmpRoot = yield* fs.makeTempDirectoryScoped({
      prefix: "t3code-icon-build-",
    });

    const iconPngPath = path.join(stageResourcesDir, "icon.png");
    const iconIcnsPath = path.join(stageResourcesDir, "icon.icns");

    yield* runCommand(
      ChildProcess.make({
        ...commandOutputOptions(verbose),
      })`sips -z 512 512 ${iconSource} --out ${iconPngPath}`,
    );

    yield* generateMacIconSet(iconSource, iconIcnsPath, tmpRoot, path, verbose);
  });
}

function stageLinuxIcons(stageResourcesDir: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const iconSource = yield* ProductionLinuxIconSource;
    if (!(yield* fs.exists(iconSource))) {
      return yield* new BuildScriptError({
        message: `Production icon source is missing at ${iconSource}`,
      });
    }

    const iconPath = path.join(stageResourcesDir, "icon.png");
    yield* fs.copyFile(iconSource, iconPath);
  });
}

function stageWindowsIcons(stageResourcesDir: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const iconSource = yield* ProductionWindowsIconSource;
    if (!(yield* fs.exists(iconSource))) {
      return yield* new BuildScriptError({
        message: `Production Windows icon source is missing at ${iconSource}`,
      });
    }

    const iconPath = path.join(stageResourcesDir, "icon.ico");
    yield* fs.copyFile(iconSource, iconPath);
  });
}

function validateBundledClientAssets(clientDir: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const indexPath = path.join(clientDir, "index.html");
    const indexHtml = yield* fs.readFileString(indexPath);
    const refs = [...indexHtml.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)]
      .map((match) => match[1])
      .filter((value): value is string => value !== undefined);
    const missing: string[] = [];

    for (const ref of refs) {
      const normalizedRef = ref.split("#")[0]?.split("?")[0] ?? "";
      if (!normalizedRef) continue;
      if (normalizedRef.startsWith("http://") || normalizedRef.startsWith("https://")) continue;
      if (normalizedRef.startsWith("data:") || normalizedRef.startsWith("mailto:")) continue;

      const ext = path.extname(normalizedRef);
      if (!ext) continue;

      const relativePath = normalizedRef.replace(/^\/+/, "");
      const assetPath = path.join(clientDir, relativePath);
      if (!(yield* fs.exists(assetPath))) {
        missing.push(normalizedRef);
      }
    }

    if (missing.length > 0) {
      const preview = missing.slice(0, 6).join(", ");
      const suffix = missing.length > 6 ? ` (+${missing.length - 6} more)` : "";
      return yield* new BuildScriptError({
        message: `Bundled client references missing files in ${indexPath}: ${preview}${suffix}. Rebuild web/server artifacts.`,
      });
    }
  });
}

function resolveDesktopRuntimeDependencies(
  dependencies: Record<string, unknown> | undefined,
  catalog: Record<string, unknown>,
): Record<string, unknown> {
  if (!dependencies || Object.keys(dependencies).length === 0) {
    return {};
  }

  const runtimeDependencies = Object.fromEntries(
    Object.entries(dependencies).filter(([dependencyName]) => dependencyName !== "electron"),
  );

  return resolveCatalogDependencies(runtimeDependencies, catalog, "apps/desktop");
}

function resolveGitHubPublishConfig():
  | {
      readonly provider: "github";
      readonly owner: string;
      readonly repo: string;
      readonly releaseType: "release";
    }
  | undefined {
  const rawRepo =
    process.env.T3CODE_DESKTOP_UPDATE_REPOSITORY?.trim() ||
    process.env.GITHUB_REPOSITORY?.trim() ||
    "";
  if (!rawRepo) return undefined;

  const [owner, repo, ...rest] = rawRepo.split("/");
  if (!owner || !repo || rest.length > 0) return undefined;

  return {
    provider: "github",
    owner,
    repo,
    releaseType: "release",
  };
}

const createBuildConfig = Effect.fn("createBuildConfig")(function* (
  platform: typeof BuildPlatform.Type,
  target: string,
  productName: string,
  signed: boolean,
) {
  const buildConfig: Record<string, unknown> = {
    appId: "com.t3tools.t3code",
    productName,
    artifactName: "T3-Code-${version}-${arch}.${ext}",
    directories: {
      buildResources: "apps/desktop/resources",
    },
  };
  const publishConfig = resolveGitHubPublishConfig();
  if (publishConfig) {
    buildConfig.publish = [publishConfig];
  }

  if (platform === "mac") {
    buildConfig.mac = {
      target: target === "dmg" ? [target, "zip"] : [target],
      icon: "icon.icns",
      category: "public.app-category.developer-tools",
    };
  }

  if (platform === "linux") {
    const linuxConfig: Record<string, unknown> = {
      target: [target],
      executableName: LINUX_EXECUTABLE_NAME,
      icon: "icon.png",
      category: "Development",
      desktop: {
        entry: createLinuxDesktopEntry(productName),
      },
      extraFiles: [
        {
          from: APPIMAGE_APPDATA_PATH,
          to: APPIMAGE_APPDATA_RELATIVE_TARGET,
        },
      ],
    };
    buildConfig.linux = {
      ...linuxConfig,
    };
  }

  if (platform === "win") {
    const winConfig: Record<string, unknown> = {
      target: [target],
      icon: "icon.ico",
    };
    if (signed) {
      winConfig.azureSignOptions = yield* AzureTrustedSigningOptionsConfig;
    }
    buildConfig.win = winConfig;
  }

  return buildConfig;
});

const assertPlatformBuildResources = Effect.fn("assertPlatformBuildResources")(function* (
  platform: typeof BuildPlatform.Type,
  stageResourcesDir: string,
  verbose: boolean,
) {
  if (platform === "mac") {
    yield* stageMacIcons(stageResourcesDir, verbose);
    return;
  }

  if (platform === "linux") {
    yield* stageLinuxIcons(stageResourcesDir);
    return;
  }

  if (platform === "win") {
    yield* stageWindowsIcons(stageResourcesDir);
  }
});

const buildDesktopArtifact = Effect.fn("buildDesktopArtifact")(function* (
  options: ResolvedBuildOptions,
) {
  const repoRoot = yield* RepoRoot;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;

  const platformConfig = PLATFORM_CONFIG[options.platform];
  if (!platformConfig) {
    return yield* new BuildScriptError({
      message: `Unsupported platform '${options.platform}'.`,
    });
  }

  const electronVersion = desktopPackageJson.dependencies.electron;

  const serverDependencies = serverPackageJson.dependencies;
  if (!serverDependencies || Object.keys(serverDependencies).length === 0) {
    return yield* new BuildScriptError({
      message: "Could not resolve production dependencies from apps/server/package.json.",
    });
  }

  const resolvedServerDependencies = yield* Effect.try({
    try: () =>
      resolveCatalogDependencies(
        serverDependencies,
        rootPackageJson.workspaces.catalog,
        "apps/server",
      ),
    catch: (cause) =>
      new BuildScriptError({
        message: "Could not resolve production dependencies from apps/server/package.json.",
        cause,
      }),
  });
  const resolvedDesktopRuntimeDependencies = yield* Effect.try({
    try: () =>
      resolveDesktopRuntimeDependencies(
        desktopPackageJson.dependencies,
        rootPackageJson.workspaces.catalog,
      ),
    catch: (cause) =>
      new BuildScriptError({
        message: "Could not resolve desktop runtime dependencies from apps/desktop/package.json.",
        cause,
      }),
  });

  const appVersion = options.version ?? serverPackageJson.version;
  const appImageReleaseDate = resolveAppImageReleaseDate();
  const commitHash = resolveGitCommitHash(repoRoot);
  const mkdir = options.keepStage ? fs.makeTempDirectory : fs.makeTempDirectoryScoped;
  const stageRoot = yield* mkdir({
    prefix: `t3code-desktop-${options.platform}-stage-`,
  });

  const stageAppDir = path.join(stageRoot, "app");
  const stageResourcesDir = path.join(stageAppDir, "apps/desktop/resources");
  const distDirs = {
    desktopDist: path.join(repoRoot, "apps/desktop/dist-electron"),
    desktopResources: path.join(repoRoot, "apps/desktop/resources"),
    serverDist: path.join(repoRoot, "apps/server/dist"),
  };
  const bundledClientEntry = path.join(distDirs.serverDist, "client/index.html");

  if (!options.skipBuild) {
    yield* Effect.log("[desktop-artifact] Building desktop/server/web artifacts...");
    yield* runCommand(
      ChildProcess.make({
        cwd: repoRoot,
        ...commandOutputOptions(options.verbose),
        // Windows needs shell mode to resolve .cmd shims (e.g. bun.cmd).
        shell: process.platform === "win32",
      })`bun run build:desktop`,
    );
  }

  for (const [label, dir] of Object.entries(distDirs)) {
    if (!(yield* fs.exists(dir))) {
      return yield* new BuildScriptError({
        message: `Missing ${label} at ${dir}. Run 'bun run build:desktop' first.`,
      });
    }
  }

  if (!(yield* fs.exists(bundledClientEntry))) {
    return yield* new BuildScriptError({
      message: `Missing bundled server client at ${bundledClientEntry}. Run 'bun run build:desktop' first.`,
    });
  }

  yield* validateBundledClientAssets(path.dirname(bundledClientEntry));

  yield* fs.makeDirectory(path.join(stageAppDir, "apps/desktop"), { recursive: true });
  yield* fs.makeDirectory(path.join(stageAppDir, "apps/server"), { recursive: true });

  yield* Effect.log("[desktop-artifact] Staging release app...");
  yield* fs.copy(distDirs.desktopDist, path.join(stageAppDir, "apps/desktop/dist-electron"));
  yield* fs.copy(distDirs.desktopResources, stageResourcesDir);
  yield* fs.copy(distDirs.serverDist, path.join(stageAppDir, "apps/server/dist"));

  const stageAppImageAppDataPath = path.join(stageResourcesDir, APPIMAGE_APPDATA_RELATIVE_TARGET);
  if (options.platform === "linux") {
    yield* writeAppImageAppData(
      stageAppImageAppDataPath,
      stageAppImageAppDataPath,
      appVersion,
      appImageReleaseDate,
    );
  }

  yield* assertPlatformBuildResources(options.platform, stageResourcesDir, options.verbose);

  const stagePackageJson: StagePackageJson = {
    name: "t3-code-desktop",
    version: appVersion,
    buildVersion: appVersion,
    t3codeCommitHash: commitHash,
    private: true,
    description: "T3 Code desktop build",
    author: "T3 Tools",
    main: "apps/desktop/dist-electron/main.js",
    build: yield* createBuildConfig(
      options.platform,
      options.target,
      desktopPackageJson.productName ?? "T3 Code",
      options.signed,
    ),
    dependencies: {
      ...resolvedServerDependencies,
      ...resolvedDesktopRuntimeDependencies,
    },
    devDependencies: {
      electron: electronVersion,
    },
  };

  const stagePackageJsonString = yield* encodeJsonString(stagePackageJson);
  yield* fs.writeFileString(path.join(stageAppDir, "package.json"), `${stagePackageJsonString}\n`);

  yield* Effect.log("[desktop-artifact] Installing staged production dependencies...");
  yield* runCommand(
    ChildProcess.make({
      cwd: stageAppDir,
      ...commandOutputOptions(options.verbose),
      // Windows needs shell mode to resolve .cmd shims (e.g. bun.cmd).
      shell: process.platform === "win32",
    })`bun install --production`,
  );

  const buildEnv: NodeJS.ProcessEnv = {
    ...process.env,
  };
  for (const [key, value] of Object.entries(buildEnv)) {
    if (value === "") {
      delete buildEnv[key];
    }
  }
  if (!options.signed) {
    buildEnv.CSC_IDENTITY_AUTO_DISCOVERY = "false";
    delete buildEnv.CSC_LINK;
    delete buildEnv.CSC_KEY_PASSWORD;
    delete buildEnv.APPLE_API_KEY;
    delete buildEnv.APPLE_API_KEY_ID;
    delete buildEnv.APPLE_API_ISSUER;
  }

  if (process.platform === "win32") {
    const python = resolvePythonForNodeGyp();
    if (python) {
      buildEnv.PYTHON = python;
      buildEnv.npm_config_python = python;
    }
    buildEnv.npm_config_msvs_version = buildEnv.npm_config_msvs_version ?? "2022";
    buildEnv.GYP_MSVS_VERSION = buildEnv.GYP_MSVS_VERSION ?? "2022";
  }

  yield* Effect.log(
    `[desktop-artifact] Building ${options.platform}/${options.target} (arch=${options.arch}, version=${appVersion})...`,
  );
  yield* runCommand(
    ChildProcess.make({
      cwd: stageAppDir,
      env: buildEnv,
      ...commandOutputOptions(options.verbose),
      // Windows needs shell mode to resolve .cmd shims.
      shell: process.platform === "win32",
    })`bunx electron-builder ${platformConfig.cliFlag} --${options.arch} --publish never`,
  );

  const stageDistDir = path.join(stageAppDir, "dist");
  if (!(yield* fs.exists(stageDistDir))) {
    return yield* new BuildScriptError({
      message: `Build completed but dist directory was not found at ${stageDistDir}`,
    });
  }

  const stageEntries = yield* fs.readDirectory(stageDistDir);
  yield* fs.makeDirectory(options.outputDir, { recursive: true });

  const copiedArtifacts: string[] = [];
  for (const entry of stageEntries) {
    const from = path.join(stageDistDir, entry);
    const stat = yield* fs.stat(from).pipe(Effect.catch(() => Effect.succeed(null)));
    if (!stat || stat.type !== "File") continue;

    const to = path.join(options.outputDir, entry);
    yield* fs.copyFile(from, to);
    copiedArtifacts.push(to);
  }

  if (options.platform === "linux" && options.target.toLowerCase() === "appimage") {
    if (!options.injectAppImageUpdateMetadata) {
      yield* Effect.log("[desktop-artifact] Skipping AppImage update metadata injection.");
    } else {
      const appImageArtifacts = copiedArtifacts.filter((artifact) =>
        artifact.endsWith(".AppImage"),
      );
      if (appImageArtifacts.length === 0) {
        return yield* new BuildScriptError({
          message: "AppImage metadata injection requested, but no .AppImage artifact was produced.",
        });
      }

      const injectionResult: string[] = [];
      for (const appImagePath of appImageArtifacts) {
        const injectedArtifacts = yield* injectAppImageUpdateMetadata(appImagePath, {
          appImageUpdateRepository: options.appImageUpdateRepository,
          appImageUpdateInformation: options.appImageUpdateInformation,
          arch: options.arch,
          verbose: options.verbose,
          appImageAppDataPath: stageAppImageAppDataPath,
          skipAppstreamValidation: options.skipAppImageAppstreamValidation,
        });
        injectionResult.push(...injectedArtifacts);
      }

      for (const artifact of injectionResult) {
        if (!copiedArtifacts.includes(artifact)) {
          copiedArtifacts.push(artifact);
        }
      }
    }
  }

  if (copiedArtifacts.length === 0) {
    return yield* new BuildScriptError({
      message: `Build completed but no files were produced in ${stageDistDir}`,
    });
  }

  yield* Effect.log("[desktop-artifact] Done. Artifacts:").pipe(
    Effect.annotateLogs({ artifacts: copiedArtifacts }),
  );
});

const buildDesktopArtifactCli = Command.make("build-desktop-artifact", {
  platform: Flag.choice("platform", BuildPlatform.literals).pipe(
    Flag.withDescription("Build platform (env: T3CODE_DESKTOP_PLATFORM)."),
    Flag.optional,
  ),
  target: Flag.string("target").pipe(
    Flag.withDescription(
      "Artifact target, for example dmg/AppImage/nsis (env: T3CODE_DESKTOP_TARGET).",
    ),
    Flag.optional,
  ),
  arch: Flag.choice("arch", BuildArch.literals).pipe(
    Flag.withDescription("Build arch, for example arm64/x64/universal (env: T3CODE_DESKTOP_ARCH)."),
    Flag.optional,
  ),
  buildVersion: Flag.string("build-version").pipe(
    Flag.withDescription("Artifact version metadata (env: T3CODE_DESKTOP_VERSION)."),
    Flag.optional,
  ),
  outputDir: Flag.string("output-dir").pipe(
    Flag.withDescription("Output directory for artifacts (env: T3CODE_DESKTOP_OUTPUT_DIR)."),
    Flag.optional,
  ),
  injectAppImageUpdateMetadata: Flag.boolean("inject-appimage-update-metadata").pipe(
    Flag.withDescription(
      "Inject AppImage update metadata with appimagetool (env: T3CODE_DESKTOP_INJECT_APPIMAGE_UPDATE_METADATA).",
    ),
    Flag.optional,
  ),
  appImageUpdateRepository: Flag.string("appimage-update-repository").pipe(
    Flag.withDescription(
      "Repository slug for generated AppImage update metadata, e.g. owner/repo (env: T3CODE_DESKTOP_APPIMAGE_UPDATE_REPOSITORY).",
    ),
    Flag.optional,
  ),
  appImageUpdateInformation: Flag.string("appimage-update-information").pipe(
    Flag.withDescription(
      "AppImage update metadata string (env: T3CODE_DESKTOP_APPIMAGE_UPDATE_INFORMATION).",
    ),
    Flag.optional,
  ),
  skipAppImageAppstreamValidation: Flag.boolean("skip-appimage-appstream-validation").pipe(
    Flag.withDescription(
      "Skip AppImage AppStream metadata validation when repacking with appimagetool (env: T3CODE_DESKTOP_SKIP_APPIMAGE_APPSTREAM_VALIDATION).",
    ),
    Flag.optional,
  ),
  skipBuild: Flag.boolean("skip-build").pipe(
    Flag.withDescription(
      "Skip `bun run build:desktop` and use existing dist artifacts (env: T3CODE_DESKTOP_SKIP_BUILD).",
    ),
    Flag.optional,
  ),
  keepStage: Flag.boolean("keep-stage").pipe(
    Flag.withDescription("Keep temporary staging files (env: T3CODE_DESKTOP_KEEP_STAGE)."),
    Flag.optional,
  ),
  signed: Flag.boolean("signed").pipe(
    Flag.withDescription(
      "Enable signing/notarization discovery; Windows uses Azure Trusted Signing (env: T3CODE_DESKTOP_SIGNED).",
    ),
    Flag.optional,
  ),
  verbose: Flag.boolean("verbose").pipe(
    Flag.withDescription("Stream subprocess stdout (env: T3CODE_DESKTOP_VERBOSE)."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("Build a desktop artifact for T3 Code."),
  Command.withHandler((input) => Effect.flatMap(resolveBuildOptions(input), buildDesktopArtifact)),
);

const cliRuntimeLayer = Layer.mergeAll(Logger.layer([Logger.consolePretty()]), NodeServices.layer);

const runtimeProgram = Command.run(buildDesktopArtifactCli, { version: "0.0.0" }).pipe(
  Effect.scoped,
  Effect.provide(cliRuntimeLayer),
);

if (import.meta.main) {
  NodeRuntime.runMain(runtimeProgram);
}
