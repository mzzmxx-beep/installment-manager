import { useEffect, useState } from "react";
import { getOverdueInstallments, type OverdueInstallment } from "@/lib/api";
import { formatMoney, todayIso } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function OverduePage({ onSelectCustomer }: { onSelectCustomer: (id: number) => void }) {
  const [overdue, setOverdue] = useState<OverdueInstallment[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getOverdueInstallments(todayIso())
      .then(setOverdue)
      .catch((e) => setError(String(e)));
  }, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle>الأقساط المتأخرة</CardTitle>
      </CardHeader>
      <CardContent>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {!error && !overdue && <p className="text-sm text-muted-foreground">جارٍ التحميل...</p>}
        {overdue && overdue.length === 0 && (
          <p className="text-sm text-muted-foreground">لا يوجد أقساط متأخرة حالياً.</p>
        )}
        {overdue && overdue.length > 0 && (
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-right font-medium">الزبون</th>
                  <th className="px-3 py-2 text-right font-medium">تاريخ الاستحقاق</th>
                  <th className="px-3 py-2 text-right font-medium">أيام التأخير</th>
                  <th className="px-3 py-2 text-right font-medium">المبلغ المتبقي</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {overdue.map((o) => (
                  <tr
                    key={o.installment_id}
                    className="cursor-pointer hover:bg-accent"
                    onClick={() => onSelectCustomer(o.customer_id)}
                  >
                    <td className="px-3 py-2 font-medium">{o.customer_name}</td>
                    <td className="px-3 py-2">{o.due_date}</td>
                    <td className="px-3 py-2">
                      <Badge variant={o.days_overdue > 30 ? "destructive" : "warning"}>
                        {o.days_overdue} يوم
                      </Badge>
                    </td>
                    <td className="px-3 py-2">{formatMoney(o.remaining_amount, o.currency_code)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
