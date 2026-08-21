import { useEffect, useMemo, useState } from "react";
import {
  getCustomersOverview,
  getMostOverdueCustomers,
  getSalesSummary,
  getTopCustomers,
  getTopProducts,
  type CurrencyAmount,
  type CustomerOverdueRanking,
  type CustomerOverview,
  type CustomerRanking,
  type ProductSales,
  type SalesSummary,
} from "@/lib/api";
import { formatMoney, todayIso } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type Period = "all" | "month" | "year";

function periodRange(period: Period): { from: string | null; to: string | null } {
  const today = new Date();
  if (period === "month") {
    const from = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().slice(0, 10);
    return { from, to: todayIso() };
  }
  if (period === "year") {
    const from = new Date(today.getFullYear(), 0, 1).toISOString().slice(0, 10);
    return { from, to: todayIso() };
  }
  return { from: null, to: null };
}

function formatAmounts(amounts: CurrencyAmount[]): string {
  if (amounts.length === 0) return "—";
  return amounts.map((a) => formatMoney(a.amount, a.currency_code)).join("، ");
}

export function ReportsPage({ onSelectCustomer }: { onSelectCustomer: (id: number) => void }) {
  const [period, setPeriod] = useState<Period>("all");
  const [summary, setSummary] = useState<SalesSummary[] | null>(null);
  const [topProducts, setTopProducts] = useState<ProductSales[] | null>(null);
  const [topCustomers, setTopCustomers] = useState<CustomerRanking[] | null>(null);
  const [mostOverdue, setMostOverdue] = useState<CustomerOverdueRanking[] | null>(null);
  const [overview, setOverview] = useState<CustomerOverview[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const range = useMemo(() => periodRange(period), [period]);

  useEffect(() => {
    getSalesSummary(range.from, range.to).then(setSummary).catch((e) => setError(String(e)));
  }, [range]);

  useEffect(() => {
    Promise.all([
      getTopProducts(10),
      getTopCustomers(10),
      getMostOverdueCustomers(todayIso(), 10),
      getCustomersOverview(),
    ])
      .then(([products, customers, overdue, allCustomers]) => {
        setTopProducts(products);
        setTopCustomers(customers);
        setMostOverdue(overdue);
        setOverview(allCustomers);
      })
      .catch((e) => setError(String(e)));
  }, []);

  return (
    <div className="flex flex-col gap-6">
      {error && <p className="text-sm text-destructive">{error}</p>}

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>ملخص المبيعات والأرباح</CardTitle>
            <div className="flex gap-1">
              {([
                { key: "all", label: "الكل" },
                { key: "year", label: "هذه السنة" },
                { key: "month", label: "هذا الشهر" },
              ] as { key: Period; label: string }[]).map((p) => (
                <Button
                  key={p.key}
                  size="sm"
                  variant="outline"
                  className={cn(period === p.key && "bg-accent text-accent-foreground")}
                  onClick={() => setPeriod(p.key)}
                >
                  {p.label}
                </Button>
              ))}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {!summary && <p className="text-sm text-muted-foreground">جارٍ التحميل...</p>}
          {summary && summary.length === 0 && (
            <p className="text-sm text-muted-foreground">لا يوجد مبيعات بهذه الفترة.</p>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            {summary?.map((s) => (
              <div key={s.currency_code} className="rounded-md border border-border p-4">
                <div className="mb-2 text-sm font-medium text-muted-foreground">{s.currency_code}</div>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                  <dt className="text-muted-foreground">عدد المبيعات</dt>
                  <dd className="text-right font-medium">{s.sale_count}</dd>
                  <dt className="text-muted-foreground">السعر النقدي الإجمالي</dt>
                  <dd className="text-right">{formatMoney(s.total_cash_value, s.currency_code)}</dd>
                  <dt className="text-muted-foreground">الربح (الهامش)</dt>
                  <dd className="text-right font-semibold text-success">
                    {formatMoney(s.total_markup, s.currency_code)}
                  </dd>
                  <dt className="text-muted-foreground">إجمالي التقسيط</dt>
                  <dd className="text-right">{formatMoney(s.total_installment_value, s.currency_code)}</dd>
                  <dt className="text-muted-foreground">المُحصَّل</dt>
                  <dd className="text-right">{formatMoney(s.total_collected, s.currency_code)}</dd>
                  <dt className="text-muted-foreground">المتبقي</dt>
                  <dd className="text-right">{formatMoney(s.total_outstanding, s.currency_code)}</dd>
                </dl>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>الأكثر مبيعاً</CardTitle>
          </CardHeader>
          <CardContent>
            {!topProducts && <p className="text-sm text-muted-foreground">جارٍ التحميل...</p>}
            {topProducts?.length === 0 && <p className="text-sm text-muted-foreground">لا يوجد بيانات بعد.</p>}
            <ul className="divide-y divide-border">
              {topProducts?.map((p, i) => (
                <li key={p.product_id} className="flex items-center justify-between py-2 text-sm">
                  <span className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">#{i + 1}</span>
                    <span className="font-medium">{p.product_name}</span>
                  </span>
                  <span className="flex items-center gap-3 text-muted-foreground">
                    <span>{p.total_quantity} قطعة</span>
                    <span>{formatAmounts(p.revenue_by_currency)}</span>
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>أكثر الزبائن شراءً</CardTitle>
          </CardHeader>
          <CardContent>
            {!topCustomers && <p className="text-sm text-muted-foreground">جارٍ التحميل...</p>}
            {topCustomers?.length === 0 && <p className="text-sm text-muted-foreground">لا يوجد بيانات بعد.</p>}
            <ul className="divide-y divide-border">
              {topCustomers?.map((c, i) => (
                <li
                  key={c.customer_id}
                  className="flex cursor-pointer items-center justify-between py-2 text-sm hover:bg-accent"
                  onClick={() => onSelectCustomer(c.customer_id)}
                >
                  <span className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">#{i + 1}</span>
                    <span className="font-medium">{c.customer_name}</span>
                  </span>
                  <span className="flex items-center gap-3 text-muted-foreground">
                    <span>{c.sale_count} عملية</span>
                    <span>{formatAmounts(c.total_purchased_by_currency)}</span>
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>الأكثر تأخراً بالتسديد</CardTitle>
        </CardHeader>
        <CardContent>
          {!mostOverdue && <p className="text-sm text-muted-foreground">جارٍ التحميل...</p>}
          {mostOverdue?.length === 0 && <p className="text-sm text-muted-foreground">لا يوجد متأخرات حالياً.</p>}
          {mostOverdue && mostOverdue.length > 0 && (
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-right font-medium">الزبون</th>
                    <th className="px-3 py-2 text-right font-medium">عدد الأقساط المتأخرة</th>
                    <th className="px-3 py-2 text-right font-medium">أطول تأخير</th>
                    <th className="px-3 py-2 text-right font-medium">المبلغ المتأخر</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {mostOverdue.map((c) => (
                    <tr key={c.customer_id} className="cursor-pointer hover:bg-accent" onClick={() => onSelectCustomer(c.customer_id)}>
                      <td className="px-3 py-2 font-medium">{c.customer_name}</td>
                      <td className="px-3 py-2">{c.overdue_installment_count}</td>
                      <td className="px-3 py-2">
                        <Badge variant={c.max_days_overdue > 30 ? "destructive" : "warning"}>
                          {c.max_days_overdue} يوم
                        </Badge>
                      </td>
                      <td className="px-3 py-2">{formatAmounts(c.overdue_amount_by_currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>نظرة عامة على الزبائن</CardTitle>
        </CardHeader>
        <CardContent>
          {!overview && <p className="text-sm text-muted-foreground">جارٍ التحميل...</p>}
          {overview && (
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-right font-medium">الزبون</th>
                    <th className="px-3 py-2 text-right font-medium">عدد المبيعات</th>
                    <th className="px-3 py-2 text-right font-medium">إجمالي المشتريات</th>
                    <th className="px-3 py-2 text-right font-medium">المتبقي</th>
                    <th className="px-3 py-2 text-right font-medium">آخر عملية</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {overview.map((c) => (
                    <tr key={c.customer_id} className="cursor-pointer hover:bg-accent" onClick={() => onSelectCustomer(c.customer_id)}>
                      <td className="px-3 py-2 font-medium">{c.customer_name}</td>
                      <td className="px-3 py-2">{c.sale_count}</td>
                      <td className="px-3 py-2">{formatAmounts(c.total_purchased_by_currency)}</td>
                      <td className="px-3 py-2">{formatAmounts(c.total_remaining_by_currency)}</td>
                      <td className="px-3 py-2 text-muted-foreground">{c.last_sale_date ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
