import { describe, expect, it } from "vitest";

import { encodeTsv, parseTsv } from "#/lib/tsv";

describe("encodeTsv", () => {
  it("joins cells with tabs and rows with newlines", () => {
    expect(
      encodeTsv([
        ["a", "b"],
        ["c", "d"],
      ]),
    ).toBe("a\tb\nc\td");
  });

  it("quotes cells containing a tab, newline or double quote", () => {
    expect(encodeTsv([["a\tb"]])).toBe('"a\tb"');
    expect(encodeTsv([["x\ny"]])).toBe('"x\ny"');
    expect(encodeTsv([['say "hi"']])).toBe('"say ""hi"""');
  });

  it("leaves plain cells unquoted", () => {
    expect(encodeTsv([["it's fine", "1,2"]])).toBe("it's fine\t1,2");
  });
});

describe("parseTsv", () => {
  it("splits on tabs and newlines", () => {
    expect(parseTsv("a\tb\nc\td")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("normalizes CRLF and CR line endings", () => {
    expect(parseTsv("a\r\nb\rc")).toEqual([["a"], ["b"], ["c"]]);
  });

  it("reads quoted cells with embedded tabs and newlines", () => {
    expect(parseTsv('"a\tb"\tc\n"x\ny"')).toEqual([["a\tb", "c"], ["x\ny"]]);
  });

  it("unescapes doubled quotes inside a quoted cell", () => {
    expect(parseTsv('"say ""hi"""')).toEqual([['say "hi"']]);
  });

  it("swallows the rest of the input into an unclosed quoted cell", () => {
    expect(parseTsv('"abc\tdef\nghi')).toEqual([["abc\tdef\nghi"]]);
  });

  it("treats a quote that is not at the start of a cell as a literal", () => {
    expect(parseTsv('a"b\tc')).toEqual([['a"b', "c"]]);
  });

  it("keeps the empty row produced by a trailing newline", () => {
    expect(parseTsv("a\n")).toEqual([["a"], [""]]);
  });

  it("round-trips through encodeTsv", () => {
    const rows = [
      ["plain", "with\ttab", 'with "quote"'],
      ["multi\nline", "", "end"],
    ];
    expect(parseTsv(encodeTsv(rows))).toEqual(rows);
  });
});
