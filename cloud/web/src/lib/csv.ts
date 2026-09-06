/** Escapes one CSV field per RFC 4180 — wraps in quotes whenever the value
 * contains a comma, quote, or newline, doubling any inner quotes. */
function escapeCsvField(value: string | number): string {
  const s = String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function toCsv(headers: string[], rows: (string | number)[][]): string {
  const lines = [headers, ...rows].map((row) => row.map(escapeCsvField).join(","));
  return lines.join("\r\n");
}

/**
 * Triggers a browser download of `headers`/`rows` as a CSV file. Prefixed
 * with a UTF-8 BOM so Excel (the realistic target for these exports) reads
 * Arabic text correctly instead of showing mojibake.
 */
export function downloadCsv(filename: string, headers: string[], rows: (string | number)[][]): void {
  const csv = "﻿" + toCsv(headers, rows);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
