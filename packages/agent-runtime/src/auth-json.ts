/**
 * Persist provider API keys to pi-native `auth.json`.
 *
 * Important: `ModelRuntime.setRuntimeApiKey` only stores keys in a **memory**
 * overlay (`RuntimeCredentials`) and does not write disk. Without writing
 * auth.json, custom-model / settings keys vanish whenever the Agent Host
 * restarts — the Auth page then shows “未配置”.
 *
 * Format matches pi docs/providers.md:
 *   { "provider": { "type": "api_key", "key": "..." } }
 */
import { join } from "node:path";
import { updateJsonFile } from "./json-file.ts";

const AUTH_FILE = "auth.json";

export function authJsonPath(agentDir: string): string {
  return join(agentDir, AUTH_FILE);
}

/** Write or replace a provider API key in auth.json (durable). */
export async function persistProviderApiKey(
  agentDir: string,
  provider: string,
  apiKey: string,
): Promise<void> {
  const providerId = provider.trim();
  const key = apiKey.trim();
  if (!providerId) throw new Error("Provider is required");
  if (!key) throw new Error("API key is required");

  await updateJsonFile(
    authJsonPath(agentDir),
    () => ({}),
    (data) => {
      Object.defineProperty(data, providerId, {
        value: { type: "api_key", key },
        enumerable: true,
        configurable: true,
        writable: true,
      });
      return true;
    },
  );
}

/** Remove a provider credential from auth.json (if present). */
export async function deleteProviderCredential(agentDir: string, provider: string): Promise<void> {
  const providerId = provider.trim();
  if (!providerId) return;

  await updateJsonFile(
    authJsonPath(agentDir),
    () => ({}),
    (data) => {
      if (!Object.hasOwn(data, providerId)) return false;
      delete data[providerId];
      return true;
    },
  );
}
