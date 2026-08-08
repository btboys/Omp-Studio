/**
 * Helpers for turning raw `omp update` CLI output into user-facing toast
 * messages. The CLI emits ANSI color codes, so strip them before inspecting.
 */

/** Remove ANSI SGR color escape sequences from CLI output. */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}

/** Last non-empty line (trimmed) — usually the most relevant error/message. */
export function lastLine(s: string): string {
  const lines = meaningfulLines(s);
  return lines[lines.length - 1] || "";
}

/** Non-empty trimmed lines, excluding known libuv assertion noise. */
function meaningfulLines(s: string): string[] {
  return s
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !isLibuvNoise(l));
}

/** True for lines produced by the Windows libuv UV_HANDLE_CLOSING assertion. */
function isLibuvNoise(line: string): boolean {
  return /Assertion failed|UV_HANDLE_CLOSING|async\.c[, ]/.test(line);
}

/**
 * True when the raw output contains the known Windows libuv async-handle
 * assertion. This assertion fires during process teardown (after the actual
 * work is done) and causes a non-zero exit code even when the update succeeded.
 */
export function hasLibuvAssertion(raw: string): boolean {
  return /UV_HANDLE_CLOSING/.test(raw);
}

/** Strip libuv assertion lines so downstream checks see only real output. */
export function cleanOutput(raw: string): string {
  return meaningfulLines(raw).join("\n");
}

/**
 * True when `omp update --plugins` output indicates nothing needed updating.
 * On a no-op run the CLI prints only the final "Updated packages" / "Updated
 * <source>" line; any real work (npm/git output, "Updating ...") leaves extra
 * lines behind.
 */
export function extensionsAlreadyLatest(cleaned: string): boolean {
  const meaningful = cleaned
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/^Updated\b/.test(l));
  return meaningful.length === 0;
}
