import { useEffect, useState } from "react";
import { validateLicense, type LicenseStatus } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { COMPANY } from "@/lib/company";
import { UpdateChecker } from "@/features/settings/UpdateChecker";

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 10);
}

/** Days between issue and expiry — the license's plan length as originally
 * issued (e.g. `issue_license --days 30`), not time remaining. */
function licenseDuration(issuedAt: string, expiresAt: string | null): string {
  if (!expiresAt) return "ترخيص دائم (بلا انتهاء)";
  const start = new Date(issuedAt).getTime();
  const end = new Date(expiresAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return "—";
  const days = Math.max(0, Math.round((end - start) / 86_400_000));
  return `${days.toLocaleString("en-US")} يوماً`;
}

export function AboutPage() {
  const [license, setLicense] = useState<LicenseStatus | null>(null);

  useEffect(() => {
    validateLicense()
      .then(setLicense)
      .catch(() => {});
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>معلومات الشركة</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          <div>
            <span className="text-muted-foreground">اسم الشركة: </span>
            {COMPANY.name}
          </div>
          <div>
            <span className="text-muted-foreground">الهاتف: </span>
            <a className="hover:underline" href={`tel:${COMPANY.phone}`}>
              {COMPANY.phone}
            </a>
          </div>
          <div>
            <span className="text-muted-foreground">البريد الإلكتروني: </span>
            <a className="hover:underline" href={`mailto:${COMPANY.email}`}>
              {COMPANY.email}
            </a>
          </div>
        </CardContent>
      </Card>

      {license?.state === "Valid" && (
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>معلومات الترخيص</CardTitle>
            {license.is_trial && <Badge variant="warning">نسخة تجريبية</Badge>}
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm">
            <div>
              <span className="text-muted-foreground">مرخَّص لـ: </span>
              {license.customer_name}
            </div>
            <div>
              <span className="text-muted-foreground">تاريخ التفعيل: </span>
              {formatDate(license.activated_at)}
            </div>
            <div>
              <span className="text-muted-foreground">تاريخ النفاذ: </span>
              {license.expires_at ? formatDate(license.expires_at) : "بلا انتهاء"}
            </div>
            <div>
              <span className="text-muted-foreground">مدة الترخيص: </span>
              {licenseDuration(license.issued_at, license.expires_at)}
            </div>
          </CardContent>
        </Card>
      )}

      <UpdateChecker />
    </div>
  );
}
