import { logout } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { COMPANY } from "@/lib/company";

export function AboutPage() {
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

      <Card>
        <CardHeader>
          <CardTitle>الحساب</CardTitle>
        </CardHeader>
        <CardContent>
          <Button variant="outline" onClick={() => logout()}>
            تسجيل الخروج
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
