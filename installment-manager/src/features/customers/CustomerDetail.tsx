import { useEffect, useMemo, useState } from "react";
import {
  getCustomers,
  getSalesForCustomer,
  registerPayment,
  type CreditSale,
  type Customer,
  type CurrencyCode,
  type InstallmentPeriodUnit,
  type InstallmentStatus,
} from "@/lib/api";
import { formatMoney, todayIso, toStorageAmount } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { CustomerDocuments } from "@/features/customers/CustomerDocuments";

function statusBadge(status: InstallmentStatus) {
  if (status === "Paid") return <Badge variant="success">مسدد</Badge>;
  if (status === "Partial") return <Badge variant="warning">مسدد جزئياً</Badge>;
  return <Badge>غير مسدد</Badge>;
}

export function CustomerDetail({
  customerId,
  onBack,
  onViewStatement,
}: {
  customerId: number;
  onBack: () => void;
  onViewStatement: () => void;
}) {
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [sales, setSales] = useState<CreditSale[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [paymentDate, setPaymentDate] = useState(todayIso());
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState<CurrencyCode>("IQD");
  const [exchangeRate, setExchangeRate] = useState("1");
  const [selectedSaleId, setSelectedSaleId] = useState("");

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
    const byCurrency = new Map<
      CurrencyCode,
      { total: number; remaining: number; perPeriodTotal: Partial<Record<InstallmentPeriodUnit, number>> }
    >();
    for (const sale of sales) {
      const entry = byCurrency.get(sale.currency_code) ?? { total: 0, remaining: 0, perPeriodTotal: {} };
      entry.total += sale.total_installment_price;
      const saleRemaining = sale.installments.reduce((sum, i) => sum + i.remaining_amount, 0);
      entry.remaining += saleRemaining;
      // Only sales still owed anything contribute to the recurring total —
      // a fully paid-off sale no longer costs the customer anything. Kept
      // separate per period unit (monthly vs. daily sales aren't the same
      // recurring cost, so they're never summed together).
      if (saleRemaining > 0 && sale.installments.length > 0) {
        const unit = sale.installment_period_unit;
        entry.perPeriodTotal[unit] = (entry.perPeriodTotal[unit] ?? 0) + sale.installments[0].scheduled_amount;
      }
      byCurrency.set(sale.currency_code, entry);
    }
    return byCurrency;
  }, [sales]);

  // Sales still owed anything — the only ones payable against individually.
  const openSales = useMemo(
    () => sales.filter((sale) => sale.installments.some((i) => i.remaining_amount > 0)),
    [sales],
  );

  async function handlePayment(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result = await registerPayment({
        customer_id: customerId,
        sale_id: selectedSaleId ? Number(selectedSaleId) : null,
        payment_date: paymentDate,
        amount_paid: toStorageAmount(amount, currency),
        currency_code: currency,
        manual_exchange_rate_micros: Math.round((Number(exchangeRate) || 0) * 1_000_000),
      });
      setAmount("");
      setSelectedSaleId("");
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
      <div className="flex items-center justify-between gap-3">
        <Button variant="ghost" size="sm" onClick={onBack}>
          ← رجوع للعملاء
        </Button>
        <Button variant="outline" size="sm" onClick={onViewStatement}>
          عرض كشف الحساب
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
            <div key={cur} className="flex gap-4">
              <span>
                <span className="text-muted-foreground">المتبقي ({cur}): </span>
                <span className="font-medium">{formatMoney(t.remaining, cur)}</span>
              </span>
              {!!t.perPeriodTotal.months && (
                <span>
                  <span className="text-muted-foreground">إجمالي القسط الشهري ({cur}): </span>
                  <span className="font-medium">{formatMoney(t.perPeriodTotal.months, cur)}</span>
                </span>
              )}
              {!!t.perPeriodTotal.days && (
                <span>
                  <span className="text-muted-foreground">إجمالي القسط اليومي ({cur}): </span>
                  <span className="font-medium">{formatMoney(t.perPeriodTotal.days, cur)}</span>
                </span>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      <CustomerDocuments customerId={customerId} />

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="flex flex-col gap-4">
          {sales.map((sale) => (
            <Card key={sale.id}>
              <CardHeader>
                <CardTitle className="flex items-center justify-between text-sm font-medium">
                  <span>
                    فاتورة #{sale.id} — {sale.sale_date} — {formatMoney(sale.total_installment_price, sale.currency_code)}
                  </span>
                  <span className="text-muted-foreground">
                    {sale.agreed_months} قسط ({sale.installment_period_unit === "days" ? "يومي" : "شهري"})
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <div className="text-sm text-muted-foreground">
                  {sale.items.map((item) => `${item.product_name} ×${item.quantity}`).join("، ")}
                </div>
                {sale.guarantor_name && (
                  <div className="text-sm">
                    <span className="text-muted-foreground">الكفيل: </span>
                    {sale.guarantor_name}
                  </div>
                )}
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
                <Label htmlFor="pay-sale">الفاتورة</Label>
                <Select id="pay-sale" value={selectedSaleId} onChange={(e) => setSelectedSaleId(e.target.value)}>
                  <option value="">كل الفواتير (تلقائي)</option>
                  {openSales.map((sale) => {
                    const remaining = sale.installments.reduce((sum, i) => sum + i.remaining_amount, 0);
                    return (
                      <option key={sale.id} value={sale.id}>
                        فاتورة #{sale.id} — {sale.sale_date} — متبقي {formatMoney(remaining, sale.currency_code)}
                      </option>
                    );
                  })}
                </Select>
              </div>
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
                {selectedSaleId
                  ? "يتم توزيع الدفعة على أقدم الأقساط غير المسددة لهذه الفاتورة فقط، مع تحويل المبلغ حسب سعر الصرف أعلاه عند الحاجة."
                  : "يتم توزيع الدفعة تلقائياً على أقدم الأقساط غير المسددة من كل الفواتير وكل العملات، مع تحويل المبلغ حسب سعر الصرف أعلاه عند الحاجة."}
              </p>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
