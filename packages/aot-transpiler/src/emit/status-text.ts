/**
 * Map an HTTP status code to its standard reason phrase. Used when emitting
 * the response status line. Falls back to "OK" for unknown codes (matches
 * what most servers do).
 */
const STATUS_TEXT: Record<number, string> = {
  100: "Continue",
  101: "Switching Protocols",
  200: "OK",
  201: "Created",
  202: "Accepted",
  204: "No Content",
  301: "Moved Permanently",
  302: "Found",
  303: "See Other",
  304: "Not Modified",
  307: "Temporary Redirect",
  308: "Permanent Redirect",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  409: "Conflict",
  422: "Unprocessable Entity",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
};

export function statusText(code: number): string {
  const text = STATUS_TEXT[code];
  if (text != null) {
    return text;
  }
  // Class-based fallback: 2xx → OK, 3xx → Redirection, etc.
  if (code >= 200 && code < 300) return "OK";
  if (code >= 300 && code < 400) return "Redirection";
  if (code >= 400 && code < 500) return "Client Error";
  if (code >= 500 && code < 600) return "Server Error";
  return "OK";
}
