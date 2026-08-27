// Minimal spreadsheet formula evaluator: cell references ([A-Z]+[0-9]+) and
// + - * / ( ) with unary minus. No functions (SUM etc.) by design.
//
// - references resolve recursively (a referenced formula is evaluated too)
// - the current evaluation path detects circular references
// - empty / missing referenced cells count as 0
// - non-finite results (division by zero, non-numeric text) become #ERROR

export const ERROR_VALUE = "#ERROR";
export const REF_ERROR_VALUE = "#REF!";

export type GetRaw = (cellId: string) => string | undefined;

type Token =
  | { type: "num"; value: number }
  | { type: "ref"; id: string }
  | { type: "referr" }
  | { type: "op"; op: "+" | "-" | "*" | "/" | "(" | ")" };

class FormulaError extends Error {}

/** A formula touching a deleted cell reference (#REF!), shown distinctly. */
class RefError extends FormulaError {}

function tokenize(src: string): Array<Token> {
  const tokens: Array<Token> = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === " " || ch === "\t") {
      i++;
      continue;
    }
    if (ch === "+" || ch === "-" || ch === "*" || ch === "/" || ch === "(" || ch === ")") {
      tokens.push({ type: "op", op: ch });
      i++;
      continue;
    }
    if (src.startsWith(REF_ERROR_VALUE, i)) {
      tokens.push({ type: "referr" });
      i += REF_ERROR_VALUE.length;
      continue;
    }
    const numMatch = /^\d*\.?\d+/.exec(src.slice(i));
    if (numMatch) {
      tokens.push({ type: "num", value: Number(numMatch[0]) });
      i += numMatch[0].length;
      continue;
    }
    const refMatch = /^[A-Za-z]+\d+/.exec(src.slice(i));
    if (refMatch) {
      tokens.push({ type: "ref", id: refMatch[0].toUpperCase() });
      i += refMatch[0].length;
      continue;
    }
    throw new FormulaError(`unexpected character: ${ch}`);
  }
  return tokens;
}

class Parser {
  private pos = 0;

  constructor(
    private tokens: Array<Token>,
    private getRaw: GetRaw,
    private path: Set<string>,
  ) {}

  parse(): number {
    const value = this.parseExpr();
    if (this.pos < this.tokens.length) {
      throw new FormulaError("unexpected trailing tokens");
    }
    return value;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private parseExpr(): number {
    let value = this.parseTerm();
    for (;;) {
      const t = this.peek();
      if (t?.type === "op" && (t.op === "+" || t.op === "-")) {
        this.pos++;
        const rhs = this.parseTerm();
        value = t.op === "+" ? value + rhs : value - rhs;
      } else {
        return value;
      }
    }
  }

  private parseTerm(): number {
    let value = this.parseFactor();
    for (;;) {
      const t = this.peek();
      if (t?.type === "op" && (t.op === "*" || t.op === "/")) {
        this.pos++;
        const rhs = this.parseFactor();
        value = t.op === "*" ? value * rhs : value / rhs;
      } else {
        return value;
      }
    }
  }

  private parseFactor(): number {
    const t = this.peek();
    if (!t) throw new FormulaError("unexpected end of formula");
    if (t.type === "op" && (t.op === "-" || t.op === "+")) {
      this.pos++;
      const value = this.parseFactor();
      return t.op === "-" ? -value : value;
    }
    if (t.type === "op" && t.op === "(") {
      this.pos++;
      const value = this.parseExpr();
      const close = this.peek();
      if (!(close?.type === "op" && close.op === ")")) {
        throw new FormulaError("missing closing parenthesis");
      }
      this.pos++;
      return value;
    }
    if (t.type === "num") {
      this.pos++;
      return t.value;
    }
    if (t.type === "ref") {
      this.pos++;
      return this.refValue(t.id);
    }
    if (t.type === "referr") {
      throw new RefError("deleted cell reference");
    }
    throw new FormulaError("unexpected token");
  }

  private refValue(id: string): number {
    if (this.path.has(id)) throw new FormulaError(`circular reference: ${id}`);
    const raw = this.getRaw(id);
    if (raw === undefined || raw.trim() === "") return 0;
    if (raw.startsWith("=")) {
      this.path.add(id);
      try {
        return evaluateExpression(raw.slice(1), this.getRaw, this.path);
      } finally {
        this.path.delete(id);
      }
    }
    // literal cell: non-numeric text yields NaN, surfaced as #ERROR upstream
    return Number(raw);
  }
}

function evaluateExpression(src: string, getRaw: GetRaw, path: Set<string>): number {
  return new Parser(tokenize(src), getRaw, path).parse();
}

/** Trim float noise like 0.30000000000000004 before display. */
function formatNumber(value: number): string {
  return String(Math.round(value * 1e10) / 1e10);
}

/**
 * Compute the display value of a cell.
 * `selfId` is the id of the cell being displayed, so self references
 * (A1 = "=A1") are detected as circular.
 */
export function displayValue(selfId: string, raw: string | undefined, getRaw: GetRaw): string {
  if (raw === undefined) return "";
  if (!raw.startsWith("=")) return raw;
  try {
    const path = new Set<string>([selfId]);
    const value = evaluateExpression(raw.slice(1), getRaw, path);
    if (!Number.isFinite(value)) return ERROR_VALUE;
    return formatNumber(value);
  } catch (e) {
    // RefError propagates through recursive refValue calls, so a cell that
    // references a #REF! formula shows #REF! too (Excel-style chaining).
    return e instanceof RefError ? REF_ERROR_VALUE : ERROR_VALUE;
  }
}

/**
 * Rewrite every cell reference in a formula through `mapRef`.
 * `mapRef` returns the new id, or null for a deleted cell (replaced with
 * the literal #REF!). Non-formula raws and unparsable formulas are returned
 * unchanged. Replacement is token-positional: everything between references
 * (operators, numbers, spacing) is preserved as written.
 */
export function rewriteFormulaRefs(raw: string, mapRef: (id: string) => string | null): string {
  if (!raw.startsWith("=")) return raw;
  const src = raw.slice(1);
  let out = "";
  let i = 0;
  while (i < src.length) {
    if (src.startsWith(REF_ERROR_VALUE, i)) {
      out += REF_ERROR_VALUE;
      i += REF_ERROR_VALUE.length;
      continue;
    }
    // numbers first, so digits are never consumed as part of a reference
    const numMatch = /^\d*\.?\d+/.exec(src.slice(i));
    if (numMatch) {
      out += numMatch[0];
      i += numMatch[0].length;
      continue;
    }
    const refMatch = /^[A-Za-z]+\d+/.exec(src.slice(i));
    if (refMatch) {
      out += mapRef(refMatch[0].toUpperCase()) ?? REF_ERROR_VALUE;
      i += refMatch[0].length;
      continue;
    }
    out += src[i];
    i++;
  }
  return `=${out}`;
}
