import { useEffect, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { backupDatabase, getOneDriveDir } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

function defaultBackupFileName(): string {
  return `installment-manager-backup-${new Date().toISOString().slice(0, 10)}.sqlite3`;
}

/**
 * Copies the whole live database to a location the user picks via the
 * native save dialog. "Local disk" and "Google Drive / OneDrive" both
 * resolve to the same save dialog — a synced Drive folder is just a
 * regular folder on disk once its desktop client is installed, so there is
 * nothing special to integrate — but the OneDrive option pre-fills the
 * dialog's starting folder when Windows reports one (Google Drive has no
 * equivalent env var to detect, so the user browses to it manually).
 * True cloud storage (independent of a local sync client) is intentionally
 * left unbuilt for now, per direct request, pending a Cloudflare-backed
 * backup service.
 */
export function BackupButton() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  async function runBackup(startingDir: string | null) {
    setOpen(false);
    setError(null);
    setStatus(null);
    setBusy(true);
    try {
      const fileName = defaultBackupFileName();
      const destination = await save({
        defaultPath: startingDir ? `${startingDir}/${fileName}` : fileName,
        filters: [{ name: "قاعدة بيانات SQLite", extensions: ["sqlite3"] }],
      });
      if (!destination) return;
      await backupDatabase(destination);
      setStatus(`تم حفظ النسخة الاحتياطية بنجاح في: ${destination}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleLocal() {
    await runBackup(null);
  }

  async function handleDrive() {
    const oneDriveDir = await getOneDriveDir().catch(() => null);
    await runBackup(oneDriveDir);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>نسخة احتياطية لقاعدة البيانات</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div ref={menuRef} className="relative w-fit">
          <Button type="button" disabled={busy} onClick={() => setOpen((o) => !o)}>
            {busy ? "جارٍ الحفظ..." : "حفظ نسخة احتياطية ▾"}
          </Button>
          {open && (
            <div className="absolute z-10 mt-1 w-72 rounded-md border border-border bg-card p-1 shadow-md">
              <button
                type="button"
                className="w-full rounded px-3 py-2 text-right text-sm hover:bg-accent"
                onClick={handleLocal}
              >
                حفظ محلي (القرص الصلب)
              </button>
              <button
                type="button"
                className="w-full rounded px-3 py-2 text-right text-sm hover:bg-accent"
                onClick={handleDrive}
              >
                حفظ في مجلد Google Drive أو OneDrive
              </button>
              <button
                type="button"
                disabled
                className="w-full cursor-not-allowed rounded px-3 py-2 text-right text-sm text-muted-foreground"
              >
                التخزين السحابي (قريباً)
              </button>
            </div>
          )}
        </div>
        {status && <p className="text-sm text-success">{status}</p>}
        {error && <p className="text-sm text-destructive">{error}</p>}
        <p className="text-xs text-muted-foreground">
          يفتح كلا الخيارين (المحلي وGoogle Drive/OneDrive) نافذة حفظ عادية يمكنك التصفح منها إلى أي مجلد على
          جهازك — بما في ذلك مجلد مزامنة Google Drive أو OneDrive إن وُجد. خيار "حفظ في Google Drive أو OneDrive"
          يبدأ تلقائياً من مجلد OneDrive إن كان مثبتاً على جهازك.
        </p>
      </CardContent>
    </Card>
  );
}
