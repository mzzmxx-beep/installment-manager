import { useEffect, useMemo, useState } from "react";
import {
  getCustomers,
  getSalesForCustomer,
  registerPayment,
  type CreditSale,
  type Customer,
  type CurrencyCode,
  type InstallmentStatus,
} from "@/lib/api";
import { formatMoney, todayIso, toStorageAmount } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";

function statusBadge(status: InstallmentStatus) {
  if (status === "Paid") return <Badge variant="success">مسدد</Badge>;
  if (status === "Partial") return <Badge variant="warning">مسدد جزئياً</Badge>;
  return <Badge>غير مسدد</Badge>;
}

export function CustomerDetail({ customerId, onBack }: { customerId: number; onBack: () => void }) {
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [sales, setSales] = useState<CreditSale[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [paymentDate, setPaymentDate] = useState(todayIso());
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState<CurrencyCode>("IQD");
  const [exchangeRate, setExchangeRate] = useState("1");

  async function load() {
    try {
      const [customers, salesForCustomer] = await Promise.all([
        getCustomers(),
        getSalesForCustomer(customerId),
      ]);
      setCustomer(customers.find((c) => c.id === customerId) ?? null);
      setSales(salesForCustomer);
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId]);

  const totals = useMemo(() => {
    const byCurrency = new Map<CurrencyCode, { total: number; remaining: number }>();
    for (const sale of sales) {
      const entry = byCurrency.get(sale.currency_code) ?? { total: 0, remaining: 0 };
      entry.total += sale.total_installment_price;
      entry.remaining += sale.installments.reduce((sum, i) => sum + i.remaining_amount, 0);
      byCurrency.set(sale.currency_code, entry);
    }
    return byCurrency;
  }, [sales]);

  async function handlePayment(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result = await registerPayment({
        customer_id: customerId,
        payment_date: paymentDate,
        amount_paid: toStorageAmount(amount, currency),
        currency_code: currency,
        manual_exchange_rate_micros: Math.round((Number(exchangeRate) || 0) * 1_000_000),
      });
      setAmount("");
      if (result.unallocated_amount > 0) {
        setError(
          `تم توزيع الدفعة، وتبقى مبلغ ${formatMoney(result.unallocated_amount, currency)} لم يُخصَّص (لا توجد أقساط مستحقة متبقية، أو المبلغ يتجاوز إجمالي المستحق).`,
        );
      }
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={onBack}>
          ← رجوع للعملاء
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{customer?.name ?? "..."}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
          <div>
            <span className="text-muted-foreground">الرقم الوطني: </span>
            {customer?.national_id}
          </div>
          {customer?.phone && (
            <div>
              <span className="text-muted-foreground">الهاتف: </span>
              {customer.phone}
            </div>
          )}
          {[...totals.entries()].map(([cur, t]) => (
            <div key={cur}>
              <span className="text-muted-foreground">المتبقي ({cur}): </span>
              <span className="font-medium">{formatMoney(t.remaining, cur)}</span>
            </div>
          ))}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="flex flex-col gap-4">
          {sales.map((sale) => (
            <Card key={sale.id}>
              <CardHeader>
                <CardTitle className="flex items-center justify-between text-sm font-medium">
                  <span>
                    بيع بتاريخ {sale.sale_date} — {formatMoney(sale.total_installment_price, sale.currency_code)}
                  </span>
                  <span className="text-muted-foreground">{sale.agreed_months} قسط</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <div className="text-sm text-muted-foreground">
                  {sale.items.map((item) => `${item.product_name} ×${item.quantity}`).join("، ")}
                </div>
                <div className="overflow-x-auto rounded-md border border-border">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50 text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2 text-right font-medium">تاريخ الاستحقاق</th>
                        <th className="px-3 py-2 text-right font-medium">المبلغ</th>
                        <th className="px-3 py-2 text-right font-medium">المتبقي</th>
                        <th className="px-3 py-2 text-right font-medium">الحالة</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {sale.installments.map((inst) => (
                        <tr key={inst.id}>
                          <td className="px-3 py-2">{inst.due_date}</td>
                          <td className="px-3 py-2">{formatMoney(inst.scheduled_amount, sale.currency_code)}</td>
                          <td className="px-3 py-2">{formatMoney(inst.remaining_amount, sale.currency_code)}</td>
                          <td className="px-3 py-2">{statusBadge(inst.status)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          ))}
          {sales.length === 0 && (
            <Card>
              <CardContent className="py-6 text-center text-sm text-muted-foreground">
                لا يوجد مبيعات لهذا العميل بعد.
              </CardContent>
            </Card>
          )}
        </div>

        <Card className="h-fit">
          <CardHeader>
            <CardTitle>تسجيل دفعة</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handlePayment} className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="pay-date">تاريخ الدفعة</Label>
                <Input
                  id="pay-date"
                  type="date"
                  required
                  value={paymentDate}
                  onChange={(e) => setPaymentDate(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="pay-currency">العملة</Label>
                <Select id="pay-currency" value={currency} onChange={(e) => setCurrency(e.target.value as CurrencyCode)}>
                  <option value="IQD">دينار عراقي (IQD)</option>
                  <option value="USD">دولار أمريكي (USD)</option>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="pay-amount">المبلغ</Label>
                <Input
                  id="pay-amount"
                  type="number"
                  min="0"
                  step="0.01"
                  required
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="pay-rate">سعر الصرف اليدوي (دينار مقابل دولار واحد)</Label>
                <Input
                  id="pay-rate"
                  type="number"
                  min="0"
                  step="0.000001"
                  required
                  value={exchangeRate}
                  onChange={(e) => setExchangeRate(e.target.value)}
                />
              </div>
              {error && <p className="text-sm text-destructive">{error}</p>}
              <Button type="submit" disabled={submitting}>
                تسجيل الدفعة
              </Button>
              <p className="text-xs text-muted-foreground">
                يتم توزيع الدفعة تلقائياً على أقدم الأقساط غير المسددة من كل العملات، مع تحويل المبلغ حسب سعر الصرف أعلاه عند الحاجة.
              </p>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
