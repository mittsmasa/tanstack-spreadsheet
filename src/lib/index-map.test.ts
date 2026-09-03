import { describe, expect, it } from "vitest";

import { blockMoveMap, deletionMap, identityMap, insertionMap } from "#/lib/index-map";

import type { IndexMap } from "#/lib/index-map";

/** Apply a map to 0..n-1 so a whole permutation reads at a glance. */
function table(map: IndexMap, n: number): Array<number | null> {
  return Array.from({ length: n }, (_, i) => map(i));
}

describe("identityMap", () => {
  it("returns every index unchanged", () => {
    expect(table(identityMap, 4)).toEqual([0, 1, 2, 3]);
  });
});

describe("deletionMap", () => {
  it("drops the deleted index and shifts later ones down", () => {
    expect(table(deletionMap([1]), 4)).toEqual([0, null, 1, 2]);
  });

  it("handles several deletions at once", () => {
    expect(table(deletionMap([0, 2]), 5)).toEqual([null, 0, null, 1, 2]);
  });

  it("is the identity with nothing deleted", () => {
    expect(table(deletionMap([]), 3)).toEqual([0, 1, 2]);
  });

  it("ignores duplicate entries", () => {
    expect(table(deletionMap([1, 1]), 3)).toEqual([0, null, 1]);
  });
});

describe("insertionMap", () => {
  it("shifts indexes at or past the insertion point", () => {
    expect(table(insertionMap(2, 3), 4)).toEqual([0, 1, 5, 6]);
  });

  it("shifts everything when inserting at 0", () => {
    expect(table(insertionMap(0, 1), 3)).toEqual([1, 2, 3]);
  });
});

describe("blockMoveMap", () => {
  it("is a no-op when dropped inside or right after the block", () => {
    expect(blockMoveMap(1, 2, 1)).toBeNull();
    expect(blockMoveMap(1, 2, 2)).toBeNull();
    expect(blockMoveMap(1, 2, 3)).toBeNull();
  });

  it("moves a block forward (before a later index)", () => {
    // [0,1,2,3,4] -> [0,3,1,2,4]
    expect(table(blockMoveMap(1, 2, 4)!, 5)).toEqual([0, 2, 3, 1, 4]);
  });

  it("moves a block backward (before an earlier index)", () => {
    // [0,1,2,3,4] -> [2,3,0,1,4]
    expect(table(blockMoveMap(2, 3, 0)!, 5)).toEqual([2, 3, 0, 1, 4]);
  });

  it("moves a block to the very end", () => {
    // [0,1,2,3] -> [0,2,3,1]
    expect(table(blockMoveMap(1, 1, 4)!, 4)).toEqual([0, 3, 1, 2]);
  });

  it("produces a permutation", () => {
    const map = blockMoveMap(2, 4, 7)!;
    const out = table(map, 8);
    expect(out.toSorted((a, b) => Number(a) - Number(b))).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
});
