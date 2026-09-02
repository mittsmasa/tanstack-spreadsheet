import { describe, expect, it } from "vitest";

import { ERROR_VALUE, REF_ERROR_VALUE, displayValue, rewriteFormulaRefs } from "#/lib/formula";

import type { GetRaw } from "#/lib/formula";

function sheet(cells: Record<string, string>): GetRaw {
  return (id) => cells[id];
}

/** Evaluate `raw` as if it sat in cell Z99, against `cells`. */
function evaluate(raw: string, cells: Record<string, string> = {}): string {
  return displayValue("Z99", raw, sheet(cells));
}

describe("displayValue", () => {
  it("shows non-formula raws as they are", () => {
    expect(evaluate("hello")).toBe("hello");
    expect(evaluate("12")).toBe("12");
    expect(evaluate("")).toBe("");
  });

  it("shows nothing for an absent cell", () => {
    expect(displayValue("A1", undefined, sheet({}))).toBe("");
  });

  describe("arithmetic", () => {
    it.each([
      ["=1+2", "3"],
      ["=2+3*4", "14"],
      ["=(2+3)*4", "20"],
      ["=10/4", "2.5"],
      ["=-3+5", "2"],
      ["=--3", "3"],
      ["=+4", "4"],
      ["=2*-3", "-6"],
      ["= 1 + 2 ", "3"],
      ["=.5+.5", "1"],
    ])("%s -> %s", (raw, expected) => {
      expect(evaluate(raw)).toBe(expected);
    });

    it("trims float noise", () => {
      expect(evaluate("=0.1+0.2")).toBe("0.3");
    });
  });

  describe("references", () => {
    it("reads referenced literals", () => {
      expect(evaluate("=A1*2", { A1: "10" })).toBe("20");
    });

    it("accepts lowercase references", () => {
      expect(evaluate("=a1*2", { A1: "10" })).toBe("20");
    });

    it("treats empty and missing cells as 0", () => {
      expect(evaluate("=B1+1", {})).toBe("1");
      expect(evaluate("=B1+1", { B1: "   " })).toBe("1");
    });

    it("evaluates referenced formulas recursively", () => {
      expect(evaluate("=A1*2", { A1: "=B1+1", B1: "2" })).toBe("6");
    });
  });

  describe("errors", () => {
    it("flags a direct self reference", () => {
      expect(displayValue("A1", "=A1", sheet({}))).toBe(ERROR_VALUE);
    });

    it("flags a cycle through other cells", () => {
      const cells = { A1: "=B1", B1: "=A1" };
      expect(displayValue("A1", cells.A1, sheet(cells))).toBe(ERROR_VALUE);
    });

    it("flags division by zero", () => {
      expect(evaluate("=1/0")).toBe(ERROR_VALUE);
    });

    it("flags text in a referenced cell", () => {
      expect(evaluate("=A1+1", { A1: "abc" })).toBe(ERROR_VALUE);
    });

    it.each(["=1+", "=(1+2", "=1 2", "=$", "=", "=)"])("flags the malformed formula %j", (raw) => {
      expect(evaluate(raw)).toBe(ERROR_VALUE);
    });
  });

  describe("#REF!", () => {
    it("shows #REF! for a formula containing a deleted reference", () => {
      expect(evaluate("=#REF!+1")).toBe(REF_ERROR_VALUE);
    });

    it("chains #REF! through references", () => {
      expect(evaluate("=A1+1", { A1: "=#REF!" })).toBe(REF_ERROR_VALUE);
    });
  });
});

/** A1 -> A2: the map a "insert one row above" operation would produce. */
const shiftDown = (id: string) => id.replace(/\d+$/, (n) => String(Number(n) + 1));

describe("rewriteFormulaRefs", () => {
  it("leaves non-formula raws untouched", () => {
    expect(rewriteFormulaRefs("A1", shiftDown)).toBe("A1");
    expect(rewriteFormulaRefs("", shiftDown)).toBe("");
  });

  it("rewrites every reference through the map", () => {
    expect(rewriteFormulaRefs("=A1+B2*C3", shiftDown)).toBe("=A2+B3*C4");
  });

  it("replaces deleted references with #REF!", () => {
    expect(rewriteFormulaRefs("=A1+B2", (id) => (id === "A1" ? null : id))).toBe("=#REF!+B2");
  });

  it("does not touch numbers, operators or spacing", () => {
    expect(rewriteFormulaRefs("= A1 * 10 + (2.5)", shiftDown)).toBe("= A2 * 10 + (2.5)");
  });

  it("hands the map uppercase ids", () => {
    const seen: Array<string> = [];
    rewriteFormulaRefs("=a1+Bb2", (id) => {
      seen.push(id);
      return id;
    });
    expect(seen).toEqual(["A1", "BB2"]);
  });

  it("keeps an existing #REF! as is", () => {
    expect(rewriteFormulaRefs("=#REF!+A1", shiftDown)).toBe("=#REF!+A2");
  });
});
