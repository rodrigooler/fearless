export function normalizePath(path: string): string {
  if (!path || path === "/") {
    return "/";
  }

  const queryIndex = path.indexOf("?");
  let normalized = queryIndex === -1 ? path : path.slice(0, queryIndex);

  if (normalized === "") {
    return "/";
  }

  const lastChar = normalized.charCodeAt(normalized.length - 1);
  if (lastChar !== 47) {
    return normalized.charCodeAt(0) === 47 ? normalized : `/${normalized}`;
  }

  if (normalized.charCodeAt(0) !== 47) {
    normalized = `/${normalized}`;
  }

  let end = normalized.length;
  while (end > 1 && normalized.charCodeAt(end - 1) === 47) {
    end -= 1;
  }

  if (end !== normalized.length) {
    normalized = normalized.slice(0, end);
  }

  return normalized.length === 0 ? "/" : normalized;
}
