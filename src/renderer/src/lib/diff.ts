/**
 * Minimal unified-diff parser for `git diff` output (the format produced by
 * gitFileDiff in the main process). Splits the text into renderable lines with
 * tracked old/new line numbers; the diff itself is kept opaque, so this also
 * handles synthesized new-file diffs and truncated output.
 */

export type DiffLineKind = "file" | "hunk" | "meta" | "add" | "del" | "ctx";

export interface DiffLine {
  kind: DiffLineKind;
  /** line number in the old version (null when not applicable) */
  oldNo: number | null;
  /** line number in the new version (null when not applicable) */
  newNo: number | null;
  text: string;
}

export interface ParsedDiff {
  files: number;
  additions: number;
  deletions: number;
  lines: DiffLine[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

export function parseDiff(diff: string): ParsedDiff {
  const lines: DiffLine[] = [];
  let files = 0;
  let additions = 0;
  let deletions = 0;
  let oldNo = 0;
  let newNo = 0;

  for (const raw of diff.split("\n")) {
    if (!raw) continue; // trailing newline; diff lines are never empty
    if (raw.startsWith("diff --git ")) {
      files += 1;
      oldNo = 0;
      newNo = 0;
      lines.push({ kind: "file", oldNo: null, newNo: null, text: raw });
    } else if (raw.startsWith("@@")) {
      const match = HUNK_RE.exec(raw);
      if (match) {
        oldNo = Number(match[1]);
        newNo = Number(match[3]);
      }
      lines.push({ kind: "hunk", oldNo: null, newNo: null, text: raw });
    } else if (raw.startsWith("+++") || raw.startsWith("---")) {
      lines.push({ kind: "meta", oldNo: null, newNo: null, text: raw });
    } else if (raw.startsWith("+")) {
      additions += 1;
      lines.push({ kind: "add", oldNo: null, newNo, text: raw.slice(1) });
      newNo += 1;
    } else if (raw.startsWith("-")) {
      deletions += 1;
      lines.push({ kind: "del", oldNo, newNo: null, text: raw.slice(1) });
      oldNo += 1;
    } else if (raw.startsWith(" ")) {
      lines.push({ kind: "ctx", oldNo, newNo, text: raw.slice(1) });
      oldNo += 1;
      newNo += 1;
    } else {
      lines.push({ kind: "meta", oldNo: null, newNo: null, text: raw });
    }
  }

  return { files, additions, deletions, lines };
}
