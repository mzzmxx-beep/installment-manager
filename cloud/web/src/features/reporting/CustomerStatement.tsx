import { useEffect, useState } from "react";
import { getCustomerStatement, type CustomerStatement as CustomerStatementData } from "@/lib/api";
import { formatMoney, shortId } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export function CustomerStatement({ customerId, onBack }: { customerId: string; onBack: () => void }) {
  const [statement, setStatement] = useState<CustomerStatementData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getCustomerStatement(customerId)
      .then(setStatement)
      .catch((e) => setError(String(e)));
  }, [customerId]);

  if (error) {
    return (
      <div dir="rtl" className="p-8 text-sm text-destructive">
        {error}
      </div>
    );
  }
  if (!statement) {
    return <div dir="rtl" className="p-8 text-sm text-muted-foreground">جارٍ التحميل...</div>;
  }

  const { customer, sales, payments, balances } = statement;

  return (
    <div dir="rtl" className="min-h-screen bg-background text-right">
      <div className="mx-auto max-w-3xl px-6 py-8 print:max-w-none print:px-0 print:py-0">
        <div className="mb-6 flex items-center justify-between print:hidden">
          <Button variant="ghost" size="sm" onClick={onBack}>
            ← رجوع
          </Button>
          <Button onClick={() => window.print()}>طباعة / تصدير PDF</Button>
        </div>

        <div className="flex flex-col gap-1 border-b border-border pb-4">
          <h1 className="text-2xl font-semibold">كشف حساب</h1>
          <p className="text-sm text-muted-foreground">تاريخ الإصدار: {new Date().toISOString().slice(0, 10)}</p>
        </div>

        <div className="mt-4 grid gap-1 text-sm">
          <div>
            <span className="text-muted-foreground">الزبون: </span>
            <span className="font-medium">{customer.name}</span>
          </div>
          <div>
            <span className="text-muted-foreground">الرقم الوطني: </span>
            {customer.national_id}
          </div>
          {customer.phone && (
            <div>
              <span className="text-muted-foreground">الهاتف: </span>
              {customer.phone}
            </div>
          )}
        </div>

        <div className="mt-6 flex flex-wrap gap-4 rounded-md border border-border p-4">
          {balances.length === 0 && <span className="text-sm text-muted-foreground">لا يوجد رصيد مستحق.</span>}
          {balances.map((b) => (
            <div key={b.currency_code} className="flex flex-col">
              <span className="text-xs text-muted-foreground">الرصيد المستحق ({b.currency_code})</span>
              <span className="text-lg font-semibold">{formatMoney(b.total_remaining, b.currency_code)}</span>
            </div>
          ))}
        </div>

        <section className="mt-8">
          <h2 className="mb-3 text-lg font-semibold">المبيعات بالتقسيط</h2>
          <div className="flex flex-col gap-4">
            {sales.map((sale) => (
              <div key={sale.id} className="rounded-md border border-border p-4 print:break-inside-avoid">
                <div className="flex items-center justify-between text-sm font-medium">
                  <span>
                    فاتورة #{shortId(sale.id)} — بيع بتاريخ {sale.sale_date}
                  </span>
                  <span>{formatMoney(sale.total_installment_price, sale.currency_code)}</span>
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {sale.items.map((item) => `${item.product_name} ×${item.quantity}`).join("، ")}
                </div>
                <table className="mt-3 w-full text-xs">
                  <thead className="text-muted-foreground">
                    <tr>
                      <th className="py-1 text-right font-medium">الاستحقاق</th>
                      <th className="py-1 text-right font-medium">المبلغ</th>
                      <th className="py-1 text-right font-medium">المتبقي</th>
                      <th className="py-1 text-right font-medium">الحالة</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {sale.installments.map((inst) => (
                      <tr key={inst.id}>
                        <td className="py-1">{inst.due_date}</td>
                        <td className="py-1">{formatMoney(inst.scheduled_amount, sale.currency_code)}</td>
                        <td className="py-1">{formatMoney(inst.remaining_amount, sale.currency_code)}</td>
                        <td className="py-1">
                          {inst.status === "Paid" && <Badge variant="success">مسدد</Badge>}
                          {inst.status === "Partial" && <Badge variant="warning">جزئي</Badge>}
                          {inst.status === "Pending" && <Badge>غير مسدد</Badge>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
            {sales.length === 0 && <p className="text-sm text-muted-foreground">لا يوجد مبيعات.</p>}
          </div>
        </section>

        <section className="mt-8">
          <h2 className="mb-3 text-lg font-semibold">الدفعات</h2>
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-right font-medium">التاريخ</th>
                  <th className="px-3 py-2 text-right font-medium">المبلغ</th>
                  <th className="px-3 py-2 text-right font-medium">عدد التخصيصات</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {payments.map((p) => (
                  <tr key={p.id}>
                    <td className="px-3 py-2">{p.payment_date}</td>
                    <td className="px-3 py-2">{formatMoney(p.amount_paid, p.currency_code)}</td>
                    <td className="px-3 py-2">{p.allocations.length}</td>
                  </tr>
                ))}
                {payments.length === 0 && (
                  <tr>
                    <td colSpan={3} className="px-3 py-3 text-center text-sm text-muted-foreground">
                      لا يوجد دفعات.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}
