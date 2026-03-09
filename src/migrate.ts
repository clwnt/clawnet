// --- Plugin config auto-migration ---
//
// Runs on startup (register) and on config hot-reload (service tick).
// Each migration targets a setupVersion and mutates the full OpenClaw config object.
// Only safe, additive changes belong here — anything needing user input goes through `openclaw clawnet setup`.

export const CURRENT_SETUP_VERSION = 1;

interface Migration {
  version: number; // setupVersion this migration brings you to
  name: string;
  run(cfg: any, api: any): void; // mutates cfg in place
}

// Add new migrations here. They run in order for any setupVersion < their version.
const migrations: Migration[] = [
  // Example:
  // {
  //   version: 2,
  //   name: "add-some-new-default",
  //   run(cfg) {
  //     const pc = cfg.plugins?.entries?.clawnet?.config;
  //     if (pc) pc.someNewField ??= "default-value";
  //   },
  // },
];

/**
 * Run pending migrations against the full OpenClaw config object.
 * Returns true if any migrations ran (caller should write config to disk).
 */
export function migrateConfig(fullConfig: any, api: any): boolean {
  const pc = fullConfig?.plugins?.entries?.clawnet?.config;
  if (!pc) return false;

  const currentVersion = typeof pc.setupVersion === "number" ? pc.setupVersion : 0;
  if (currentVersion >= CURRENT_SETUP_VERSION) return false;

  const pending = migrations
    .filter((m) => m.version > currentVersion)
    .sort((a, b) => a.version - b.version);

  if (pending.length === 0) {
    // No migrations to run, but version is behind — bump it
    pc.setupVersion = CURRENT_SETUP_VERSION;
    return true;
  }

  for (const m of pending) {
    try {
      m.run(fullConfig, api);
      api.logger.info(`[clawnet] Migration applied: ${m.name} (v${m.version})`);
    } catch (err: any) {
      api.logger.error(`[clawnet] Migration "${m.name}" failed: ${err.message}`);
      // Stop running further migrations on failure
      return pending.indexOf(m) > 0; // true if at least one earlier migration ran
    }
  }

  pc.setupVersion = CURRENT_SETUP_VERSION;
  api.logger.info(`[clawnet] Config migrated to setupVersion ${CURRENT_SETUP_VERSION}`);
  return true;
}
