/**
 * Excel / Google Sheets 互換の TSV エンコード・デコード。
 * タブ・改行・二重引用符を含むセルは "..." で括り、内部の " は "" に倍化する。
 */

const NEEDS_QUOTING = /[\t\n"]/;

export function encodeTsv(rows: Array<Array<string>>): string {
  return rows
    .map((row) =>
      row
        .map((cell) => (NEEDS_QUOTING.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell))
        .join("\t"),
    )
    .join("\n");
}

export function parseTsv(text: string): Array<Array<string>> {
  const src = text.replace(/\r\n?/g, "\n");
  const rows: Array<Array<string>> = [];
  let row: Array<string> = [];
  let cell = "";
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"' && cell === "") {
      // quoted cell: closing quote まで消費する（"" はエスケープされた "、
      // 閉じない引用符は残り全部をセル内容とする Excel の寛容な挙動に合わせる）
      i++;
      while (i < src.length) {
        if (src[i] === '"') {
          if (src[i + 1] === '"') {
            cell += '"';
            i += 2;
          } else {
            i++;
            break;
          }
        } else {
          cell += src[i];
          i++;
        }
      }
      continue;
    }
    if (ch === "\t") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
    i++;
  }
  row.push(cell);
  rows.push(row);
  return rows;
}
