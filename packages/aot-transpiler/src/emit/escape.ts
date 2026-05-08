/**
 * Escape a string for inclusion as a Rust byte string literal: `b"..."`.
 *
 * Rust byte strings accept ASCII printable + escape sequences. Any byte outside
 * 0x20-0x7E (or `"`, `\\`) needs to be escaped as `\xHH`.
 */
export function escapeRustByteString(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) {
    if (b === 0x22) {
      // " => \"
      out += '\\"';
    } else if (b === 0x5c) {
      // \ => \\
      out += "\\\\";
    } else if (b === 0x0a) {
      out += "\\n";
    } else if (b === 0x0d) {
      out += "\\r";
    } else if (b === 0x09) {
      out += "\\t";
    } else if (b >= 0x20 && b <= 0x7e) {
      out += String.fromCharCode(b);
    } else {
      out += "\\x" + b.toString(16).padStart(2, "0");
    }
  }
  return out;
}

/**
 * Escape a string for inclusion in a JSON literal. Used when we need to emit
 * a JSON body fragment that contains arbitrary text (e.g. a route path
 * embedded in an error message).
 */
export function escapeJsonString(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c === 0x22) {
      out += '\\"';
    } else if (c === 0x5c) {
      out += "\\\\";
    } else if (c === 0x0a) {
      out += "\\n";
    } else if (c === 0x0d) {
      out += "\\r";
    } else if (c === 0x09) {
      out += "\\t";
    } else if (c < 0x20) {
      out += "\\u" + c.toString(16).padStart(4, "0");
    } else {
      out += value[i];
    }
  }
  return out;
}
