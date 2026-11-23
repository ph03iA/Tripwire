import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The repo-root .env, git-ignored. */
export const ENV_FILE = fileURLToPath(new URL("../../../.env", import.meta.url));
export const USER_AGENT = "tripwire/0.1.0"; // Meko's WAF rejects requests without a User-Agent

export type MekoConfig = { apiKey: string; mcpUrl: URL; apiUrl: URL; userAgent: string };

export class ConfigError extends Error {
  override name = "ConfigError";
}

const KEY = /^mko_tkn_\S+$/;

/** Meko settings, read once. A bad value fails with the variable's name and never its value (engineering spec §6). */
export function mekoConfig(env: Record<string, string | undefined> = loadEnv()): MekoConfig {
  const apiKey = env.MEKO_API_KEY?.trim();
  if (!apiKey) throw new ConfigError("MEKO_API_KEY is missing: add it to .env (Meko portal, Settings > API Keys)");
  if (!KEY.test(apiKey)) throw new ConfigError("MEKO_API_KEY doesn't look like a Meko key: it should start with mko_tkn_");
  return {
    apiKey,
    mcpUrl: httpsUrl(env, "MEKO_MCP_URL", "https://mcp.mekodata.ai/mcp"),
    apiUrl: httpsUrl(env, "MEKO_API_URL", "https://api.mekodata.ai/api/v1"),
    userAgent: USER_AGENT,
  };
}

function loadEnv(): Record<string, string | undefined> {
  if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
  return process.env;
}

function httpsUrl(env: Record<string, string | undefined>, name: string, fallback: string): URL {
  let url: URL;
  try {
    url = new URL(env[name] ?? fallback);
  } catch {
    throw new ConfigError(`${name} isn't a valid URL`);
  }
  if (url.protocol !== "https:") throw new ConfigError(`${name} must use https`);
  return url;
}
