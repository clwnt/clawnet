// --- Plugin config types + defaults ---

export interface ClawnetAccount {
  id: string; // lowercased ClawNet agent name (e.g. "severith")
  token: string; // env var ref like "${CLAWNET_TOKEN_SEVERITH}" or raw token
  agentId: string; // ClawNet agent name with original casing (e.g. "Severith")
  openclawAgentId: string; // OpenClaw agent to route messages to (e.g. "main")
  enabled: boolean;
}

export interface ClawnetConfig {
  baseUrl: string;
  pollEverySeconds: number;
  debounceSeconds: number;
  maxBatchSize: number;
  deliver: { channel: string };
  deliveryMethod: "hooks" | "agent";
  accounts: ClawnetAccount[];
  maxSnippetChars: number;
  setupVersion: number;
  paused: boolean;
  notifyOnNew: boolean;
  remindAfterHours: number | null;
}

const DEFAULTS: ClawnetConfig = {
  baseUrl: "https://api.clwnt.com",
  pollEverySeconds: 120,
  debounceSeconds: 30,
  maxBatchSize: 10,
  deliver: { channel: "last" },
  deliveryMethod: "agent",
  accounts: [],
  maxSnippetChars: 500,
  setupVersion: 0,
  paused: false,
  notifyOnNew: true,
  remindAfterHours: 4,
};

export function parseConfig(raw: Record<string, unknown>): ClawnetConfig {
  return {
    baseUrl: typeof raw.baseUrl === "string" ? raw.baseUrl : DEFAULTS.baseUrl,
    pollEverySeconds:
      typeof raw.pollEverySeconds === "number" && raw.pollEverySeconds >= 10
        ? raw.pollEverySeconds
        : DEFAULTS.pollEverySeconds,
    deliver: {
      channel:
        typeof (raw.deliver as any)?.channel === "string"
          ? (raw.deliver as any).channel
          : DEFAULTS.deliver.channel,
    },
    debounceSeconds:
      typeof raw.debounceSeconds === "number" && raw.debounceSeconds >= 0
        ? raw.debounceSeconds
        : DEFAULTS.debounceSeconds,
    maxBatchSize:
      typeof raw.maxBatchSize === "number" && raw.maxBatchSize >= 1
        ? raw.maxBatchSize
        : DEFAULTS.maxBatchSize,
    accounts: Array.isArray(raw.accounts)
      ? raw.accounts.map(parseAccount).filter((a): a is ClawnetAccount => a !== null)
      : DEFAULTS.accounts,
    maxSnippetChars:
      typeof raw.maxSnippetChars === "number"
        ? raw.maxSnippetChars
        : DEFAULTS.maxSnippetChars,
    setupVersion:
      typeof raw.setupVersion === "number" ? raw.setupVersion : DEFAULTS.setupVersion,
    deliveryMethod:
      raw.deliveryMethod === "agent" ? "agent" : DEFAULTS.deliveryMethod,
    paused: raw.paused === true,
    notifyOnNew: raw.notifyOnNew !== false,
    remindAfterHours: typeof raw.remindAfterHours === "number" ? raw.remindAfterHours : null,
  };
}

function parseAccount(raw: unknown): ClawnetAccount | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.token !== "string" || typeof r.agentId !== "string") {
    return null;
  }
  return {
    id: r.id,
    token: r.token,
    agentId: r.agentId,
    openclawAgentId: typeof r.openclawAgentId === "string" ? r.openclawAgentId : r.id,
    enabled: r.enabled !== false,
  };
}

/**
 * Resolve a token value — handles "${ENV_VAR}" references.
 * Returns empty string if the env var is not set or blank.
 */
export function resolveToken(token: string): string {
  const match = token.match(/^\$\{(.+)\}$/);
  if (match) {
    return process.env[match[1]]?.trim() || "";
  }
  return token.trim();
}
