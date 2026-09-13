export function isPlainSettingObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function mergeSettingValue(globalValue: unknown, projectValue: unknown): unknown {
  if (!isPlainSettingObject(projectValue)) return projectValue;
  const base = isPlainSettingObject(globalValue) ? globalValue : {};
  const merged: Record<string, unknown> = Object.create(null);
  for (const source of [base, projectValue]) {
    for (const [key, value] of Object.entries(source)) {
      if (["__proto__", "constructor", "prototype"].includes(key)) continue;
      merged[key] = mergeSettingValue(
        source === projectValue && Object.hasOwn(base, key) ? base[key] : undefined,
        value,
      );
    }
  }
  return merged;
}
