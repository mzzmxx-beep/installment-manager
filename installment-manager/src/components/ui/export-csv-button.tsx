import { downloadCsv } from "@/lib/csv";
import { Button } from "@/components/ui/button";

export function ExportCsvButton({
  filename,
  headers,
  rows,
}: {
  filename: string;
  headers: string[];
  rows: (string | number)[][];
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={rows.length === 0}
      onClick={() => downloadCsv(filename, headers, rows)}
    >
      تصدير CSV
    </Button>
  );
}
