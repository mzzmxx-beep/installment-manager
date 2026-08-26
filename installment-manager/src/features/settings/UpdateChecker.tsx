import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type Status =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "up-to-date" }
  | { state: "available"; update: Update }
  | { state: "downloading"; progress: number | null }
  | { state: "installed" }
  | { state: "error"; message: string };

/** Checks GitHub Releases (via the endpoint configured in tauri.conf.json)
 * for a newer signed build, and downloads/installs it in place — the
 * customer's database (including their activated license) is untouched,
 * same guarantee as running the NSIS installer manually. */
export function UpdateChecker() {
  const [version, setVersion] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>({ state: "idle" });

  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => {});
  }, []);

  async function handleCheck() {
    setStatus({ state: "checking" });
    try {
      const update = await check();
      setStatus(update ? { state: "available", update } : { state: "up-to-date" });
    } catch (e) {
      setStatus({ state: "error", message: String(e) });
    }
  }

  async function handleInstall(update: Update) {
    setStatus({ state: "downloading", progress: null });
    let downloaded = 0;
    let total = 0;
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? 0;
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          setStatus({ state: "downloading", progress: total > 0 ? Math.round((downloaded / total) * 100) : null });
        } else if (event.event === "Finished") {
          setStatus({ state: "installed" });
        }
      });
      await relaunch();
    } catch (e) {
      setStatus({ state: "error", message: String(e) });
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>تحديث البرنامج</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="text-sm text-muted-foreground">
          الإصدار الحالي: <span className="font-medium text-foreground">{version ?? "..."}</span>
        </div>

        {(status.state === "idle" || status.state === "up-to-date" || status.state === "error") && (
          <Button type="button" onClick={handleCheck} className="w-fit">
            التحقق من التحديثات
          </Button>
        )}
        {status.state === "checking" && <p className="text-sm text-muted-foreground">جارٍ التحقق...</p>}
        {status.state === "up-to-date" && <p className="text-sm text-success">أنت تستخدم أحدث إصدار.</p>}
        {status.state === "error" && <p className="text-sm text-destructive">{status.message}</p>}

        {status.state === "available" && (
          <div className="flex flex-col gap-2 rounded-md border border-border p-3">
            <p className="text-sm">
              يتوفر إصدار جديد: <span className="font-medium">{status.update.version}</span>
            </p>
            {status.update.body && (
              <p className="whitespace-pre-line text-sm text-muted-foreground">{status.update.body}</p>
            )}
            <Button type="button" onClick={() => handleInstall(status.update)} className="w-fit">
              تحديث الآن
            </Button>
          </div>
        )}

        {status.state === "downloading" && (
          <p className="text-sm text-muted-foreground">
            جارٍ تنزيل التحديث{status.progress !== null ? ` (${status.progress}%)` : "..."}
          </p>
        )}
        {status.state === "installed" && (
          <p className="text-sm text-success">تم التثبيت، سيُعاد تشغيل البرنامج الآن...</p>
        )}
      </CardContent>
    </Card>
  );
}
