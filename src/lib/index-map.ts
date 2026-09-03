// Position maps for structural operations (delete / insert / move of whole
// rows or columns). Pure: structure.ts builds one of these and applies it to
// cell ids, formula references and column widths in a single pass.

/** old 0-based index -> new 0-based index, or null when the position is deleted */
export type IndexMap = (index: number) => number | null;

export const identityMap: IndexMap = (index) => index;

export function deletionMap(deleted: ReadonlyArray<number>): IndexMap {
  const set = new Set(deleted);
  return (index) => {
    if (set.has(index)) return null;
    let shift = 0;
    for (const d of set) {
      if (d < index) shift++;
    }
    return index - shift;
  };
}

/** Shift everything at or past `insertAt` to make room for `count` new slots. */
export function insertionMap(insertAt: number, count: number): IndexMap {
  return (index) => (index >= insertAt ? index + count : index);
}

/**
 * Move the contiguous block [srcStart..srcEnd] so it starts where `dest`
 * ("insert before this original index") points. Returns null for a no-op
 * drop inside the block itself.
 */
export function blockMoveMap(srcStart: number, srcEnd: number, dest: number): IndexMap | null {
  if (dest >= srcStart && dest <= srcEnd + 1) return null;
  const size = srcEnd - srcStart + 1;
  const insertAt = dest < srcStart ? dest : dest - size;
  return (index) => {
    if (index >= srcStart && index <= srcEnd) return insertAt + (index - srcStart);
    const removed = index > srcEnd ? index - size : index;
    return removed >= insertAt ? removed + size : removed;
  };
}
