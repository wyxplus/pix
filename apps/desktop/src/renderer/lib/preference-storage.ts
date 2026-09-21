// A synchronous UI cache backed by desktop/preferences.json in the chosen data root.
// Unit tests and standalone demos retain the browser Storage fallback.
let values: Map<string, string> | undefined;
let queue: Promise<unknown> = Promise.resolve();
function persist(key: string, value: string | null) {
  queue = queue
    .then(() => window.pix.data.preferences.patch({ [key]: value }))
    .catch((error) => {
      window.dispatchEvent(new CustomEvent("pix:preferences-error", { detail: String(error) }));
    });
}
export const preferenceStorage = {
  getItem(key: string): string | null {
    return values ? (values.get(key) ?? null) : globalThis.localStorage.getItem(key);
  },
  setItem(key: string, value: string) {
    if (!values) return globalThis.localStorage.setItem(key, value);
    values.set(key, value);
    persist(key, value);
  },
  removeItem(key: string) {
    if (!values) return globalThis.localStorage.removeItem(key);
    values.delete(key);
    persist(key, null);
  },
};
export async function initializePreferences(): Promise<void> {
  let saved = await window.pix.data.preferences.read();
  const legacy: Record<string, string> = {};
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (key?.startsWith("pix.")) legacy[key] = localStorage.getItem(key)!;
  }
  if (saved === null) saved = await window.pix.data.preferences.patch(legacy, true);
  values = new Map(Object.entries(saved));
  // Remove legacy preference copies only after the authoritative file is durable.
  for (const key of Object.keys(legacy)) localStorage.removeItem(key);
}
