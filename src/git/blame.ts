import { td } from "./util";
import { diffLines } from "./diff";
import { Commit } from "./objects";

export interface BlameLine {
  line: string;
  oid: string;
  author: string;
  time: number;
}

export interface BlameHistoryEntry {
  oid: string;
  commit: Commit;
  /** blob content of the target path at this commit, null if absent */
  blob: Uint8Array | null;
}

const MAX_BLAME_LINES = 5000;

/**
 * Line attribution over first-parent history. `history` is the path-limited
 * log, newest first, where each entry carries the file's blob at that commit.
 * Walking from the tip backwards: lines that disappear when stepping to the
 * previous version were introduced by the commit being examined.
 */
export function blame(history: BlameHistoryEntry[]): BlameLine[] | null {
  if (!history.length || !history[0].blob) return null;
  const tipText = td.decode(history[0].blob);
  const tipLines = tipText.split("\n");
  if (tipLines[tipLines.length - 1] === "") tipLines.pop();
  if (tipLines.length > MAX_BLAME_LINES) return null;

  const owner: (BlameHistoryEntry | null)[] = tipLines.map(() => null);
  // pos[i] = line number of tip line i in the version currently being examined
  const pos: number[] = tipLines.map((_, i) => i);

  for (let h = 0; h < history.length; h++) {
    const cur = history[h];
    const parent = history[h + 1];
    const curText = cur.blob ? td.decode(cur.blob) : "";
    const parentText = parent?.blob ? td.decode(parent.blob) : "";

    if (!parent || !parent.blob) {
      // file was created here: everything still unowned belongs to this commit
      for (let i = 0; i < owner.length; i++) {
        if (!owner[i] && pos[i] >= 0) owner[i] = cur;
      }
      break;
    }

    const ops = diffLines(parentText, curText);
    if (!ops) {
      for (let i = 0; i < owner.length; i++) if (!owner[i] && pos[i] >= 0) owner[i] = cur;
      break;
    }
    // map: line index in cur -> line index in parent (only for unchanged lines)
    const eqMap = new Map<number, number>();
    let ci = 0, pi = 0;
    for (const op of ops) {
      if (op.tag === "eq") {
        eqMap.set(ci, pi);
        ci++;
        pi++;
      } else if (op.tag === "add") {
        ci++;
      } else {
        pi++;
      }
    }
    for (let i = 0; i < owner.length; i++) {
      if (owner[i] || pos[i] < 0) continue;
      const mapped = eqMap.get(pos[i]);
      if (mapped === undefined) {
        owner[i] = cur; // introduced (or last touched) by this commit
        pos[i] = -1;
      } else {
        pos[i] = mapped;
      }
    }
  }
  const oldest = history[history.length - 1];
  return tipLines.map((line, i) => {
    const o = owner[i] ?? oldest;
    return { line, oid: o.oid, author: o.commit.author.name, time: o.commit.author.time };
  });
}
