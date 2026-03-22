export function normalizePath(path: string): string {
  if (!path || path === "/") {
    return "/";
  }

  let normalized = path;
  const queryIndex = normalized.indexOf("?");
  if (queryIndex !== -1) {
    normalized = normalized.slice(0, queryIndex);
  }

  if (!normalized.startsWith("/")) {
    normalized = `/${normalized}`;
  }

  normalized = normalized.replace(/\/+$/, "");
  return normalized.length === 0 ? "/" : normalized;
}
