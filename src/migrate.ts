// --- Plugin config auto-migration ---
//
// Runs on startup (register) and on config hot-reload (service tick).
// Each migration targets a setupVersion and mutates the full OpenClaw config object.
// Only safe, additive changes belong here — anything needing user input goes through `openclaw clawnet setup`.

export const CURRENT_SETUP_VERSION = 2;

interface Migration {
  version: number; // setupVersion this migration brings you to
  name: string;
  run(cfg: any, api: any): void; // mutates cfg in place
}

// Add new migrations here. They run in order for any setupVersion < their version.
const migrations: Migration[] = [
  {
    version: 2,
    name: "tools-allow-to-alsoAllow",
    run(cfg, api) {
      // Move "clawnet" from agent-level tools.allow to global tools.alsoAllow.
      // tools.allow is a restrictive allowlist — having only ["clawnet"] blocks all
      // other tools. tools.alsoAllow is additive and the correct pattern for plugins.
      const agents = cfg.agents?.list;
      if (!Array.isArray(agents)) return;

      for (const agent of agents) {
        const allow = agent.tools?.allow;
        if (!Array.isArray(allow)) continue;

        const idx = allow.indexOf("clawnet");
        if (idx === -1) continue;

        // Remove "clawnet" from tools.allow
        allow.splice(idx, 1);

        // If allow is now empty, delete it so it doesn't act as "allow nothing"
        if (allow.length === 0) {
          delete agent.tools.allow;
          // Clean up empty tools object
          if (Object.keys(agent.tools).length === 0) delete agent.tools;
        }

        api.logger.info(`[clawnet] Removed "clawnet" from tools.allow for agent ${agent.id}`);
      }

      // Ensure global tools.alsoAllow has "clawnet"
      if (!cfg.tools) cfg.tools = {};
      if (!cfg.tools.alsoAllow) cfg.tools.alsoAllow = [];
      if (!cfg.tools.alsoAllow.includes("clawnet")) {
        cfg.tools.alsoAllow.push("clawnet");
      }
    },
  },
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
