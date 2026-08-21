import { useEffect, useState } from "react";
import { activateLicense, validateLicense, type LicenseStatus } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";

function ActivationForm({
  title,
  description,
  onActivated,
}: {
  title: string;
  description?: string;
  onActivated: (status: LicenseStatus) => void;
}) {
  const [licenseKey, setLicenseKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const status = await activateLicense(licenseKey.trim());
      if (status.state === "Valid") {
        onActivated(status);
      } else if (status.state === "Invalid") {
        setError(status.reason);
      } else if (status.state === "Expired") {
        setError(`هذا الترخيص منتهي بتاريخ ${status.expires_at}`);
      } else {
        setError("تعذر تفعيل الترخيص");
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div dir="rtl" className="flex min-h-screen items-center justify-center bg-background px-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="license-key">رمز الترخيص</Label>
              <textarea
                id="license-key"
                required
                rows={4}
                value={licenseKey}
                onChange={(e) => setLicenseKey(e.target.value)}
                placeholder="الصق رمز الترخيص هنا"
                className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-xs font-mono shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" disabled={submitting || !licenseKey.trim()}>
              تفعيل
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

function Lockdown() {
  return (
    <div dir="rtl" className="flex min-h-screen items-center justify-center bg-background px-6">
      <Card className="w-full max-w-md border-destructive/50">
        <CardHeader>
          <CardTitle className="text-destructive">تم إيقاف التطبيق</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            تم اكتشاف تغيير بساعة النظام إلى وقت أقدم من آخر تشغيل مسجّل. لأسباب أمنية، لا يمكن متابعة استخدام
            التطبيق. أعد ضبط ساعة النظام إلى الوقت الصحيح الحالي وأعد تشغيل التطبيق.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

export function LicenseGate({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<LicenseStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function check() {
    try {
      setStatus(await validateLicense());
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    check();
  }, []);

  if (error) {
    return (
      <div dir="rtl" className="flex min-h-screen items-center justify-center bg-background px-6">
        <p className="text-sm text-destructive">{error}</p>
      </div>
    );
  }

  if (!status) {
    return <div className="flex min-h-screen items-center justify-center bg-background" />;
  }

  switch (status.state) {
    case "Valid":
      return <>{children}</>;
    case "ClockRollbackDetected":
      return <Lockdown />;
    case "NotActivated":
      return (
        <ActivationForm
          title="تفعيل إدارة الأقساط"
          description="أدخل رمز الترخيص الذي حصلت عليه لتفعيل التطبيق."
          onActivated={setStatus}
        />
      );
    case "Expired":
      return (
        <ActivationForm
          title="انتهى الترخيص"
          description={`ترخيص "${status.customer_name}" انتهى بتاريخ ${status.expires_at}. أدخل رمز ترخيص جديد للمتابعة.`}
          onActivated={setStatus}
        />
      );
    case "Invalid":
      return (
        <ActivationForm
          title="ترخيص غير صالح"
          description={status.reason}
          onActivated={setStatus}
        />
      );
  }
}
