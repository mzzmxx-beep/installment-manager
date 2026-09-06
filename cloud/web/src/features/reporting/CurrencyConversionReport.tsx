import { useEffect, useState } from "react";
import {
  getCustomerConversionSummary,
  getPaymentConversions,
  getProductConversionSummary,
  getSaleConversions,
  type CustomerConversionSummary,
  type PaymentConversion,
  type ProductConversionSummary,
  type SaleConversion,
} from "@/lib/api";
import { formatAmounts, formatMoney, formatRate, shortId } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ExportCsvButton } from "@/components/ui/export-csv-button";
import { cn } from "@/lib/utils";

type Tab = "invoices" | "customers" | "products";

const TABS: { key: Tab; label: string }[] = [
  { key: "invoices", label: "حسب الفاتورة" },
  { key: "customers", label: "حسب الزبون" },
  { key: "products", label: "حسب الجهاز" },
];

/**
 * Explains every place `engine::convert_currency` actually ran (sale items
 * priced in a different currency than their invoice, and payments that
 * landed in a different currency than the installment they paid), broken
 * down per invoice, per customer, and per device/product.
 */
export function CurrencyConversionReport({
  range,
  onSelectCustomer,
}: {
  range: { from: string | null; to: string | null };
  onSelectCustomer: (id: string) => void;
}) {
  const [tab, setTab] = useState<Tab>("invoices");
  const [saleConversions, setSaleConversions] = useState<SaleConversion[] | null>(null);
  const [paymentConversions, setPaymentConversions] = useState<PaymentConversion[] | null>(null);
  const [customerSummary, setCustomerSummary] = useState<CustomerConversionSummary[] | null>(null);
  const [productSummary, setProductSummary] = useState<ProductConversionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([getSaleConversions(range.from, range.to), getPaymentConversions(range.from, range.to)])
      .then(([sales, payments]) => {
        setSaleConversions(sales);
        setPaymentConversions(payments);
      })
      .catch((e) => setError(String(e)));
  }, [range]);

  useEffect(() => {
    Promise.all([getCustomerConversionSummary(), getProductConversionSummary()])
      .then(([customers, products]) => {
        setCustomerSummary(customers);
        setProductSummary(products);
      })
      .catch((e) => setError(String(e)));
  }, []);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>تقرير تحويل العملة</CardTitle>
          <div className="flex gap-1">
            {TABS.map((t) => (
              <Button
                key={t.key}
                size="sm"
                variant="outline"
                className={cn(tab === t.key && "bg-accent text-accent-foreground")}
                onClick={() => setTab(t.key)}
              >
                {t.label}
              </Button>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {error && <p className="text-sm text-destructive">{error}</p>}

        {tab === "invoices" && (
          <>
            <div>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-sm font-medium text-muted-foreground">تحويلات ضمن الفواتير (أسعار الأجهزة)</h3>
                <ExportCsvButton
                  filename="تحويلات-ضمن-الفواتير.csv"
                  headers={["الفاتورة", "التاريخ", "الزبون", "الجهاز", "السعر الأصلي", "السعر بعد التحويل", "الكمية", "سعر الصرف (د.ع لكل $1)"]}
                  rows={(saleConversions ?? []).flatMap((sale) =>
                    sale.items.map((item) => [
                      `فاتورة #${shortId(sale.sale_id)}`,
                      sale.sale_date,
                      sale.customer_name,
                      item.product_name,
                      formatMoney(item.original_unit_price, item.original_currency),
                      formatMoney(item.converted_unit_price, item.converted_currency),
                      item.quantity,
                      formatRate(item.exchange_rate_micros),
                    ]),
                  )}
                />
              </div>
              {!saleConversions && <p className="text-sm text-muted-foreground">جارٍ التحميل...</p>}
              {saleConversions?.length === 0 && (
                <p className="text-sm text-muted-foreground">لا توجد أجهزة بيعت بعملة مختلفة عن عملة فاتورتها بهذه الفترة.</p>
              )}
              {saleConversions && saleConversions.length > 0 && (
                <div className="overflow-x-auto rounded-md border border-border">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50 text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2 text-right font-medium">الفاتورة</th>
                        <th className="px-3 py-2 text-right font-medium">الزبون</th>
                        <th className="px-3 py-2 text-right font-medium">الجهاز</th>
                        <th className="px-3 py-2 text-right font-medium">السعر الأصلي</th>
                        <th className="px-3 py-2 text-right font-medium">السعر بعد التحويل</th>
                        <th className="px-3 py-2 text-right font-medium">الكمية</th>
                        <th className="px-3 py-2 text-right font-medium">سعر الصرف (د.ع لكل $1)</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {saleConversions.flatMap((sale) =>
                        sale.items.map((item, i) => (
                          <tr key={`${sale.sale_id}-${item.product_id}-${i}`}>
                            {i === 0 && (
                              <td className="px-3 py-2 align-top" rowSpan={sale.items.length}>
                                <div className="font-medium">فاتورة #{shortId(sale.sale_id)}</div>
                                <div className="text-xs text-muted-foreground">{sale.sale_date}</div>
                              </td>
                            )}
                            {i === 0 && (
                              <td
                                className="cursor-pointer px-3 py-2 align-top hover:underline"
                                rowSpan={sale.items.length}
                                onClick={() => onSelectCustomer(sale.customer_id)}
                              >
                                {sale.customer_name}
                              </td>
                            )}
                            <td className="px-3 py-2">{item.product_name}</td>
                            <td className="px-3 py-2">{formatMoney(item.original_unit_price, item.original_currency)}</td>
                            <td className="px-3 py-2">{formatMoney(item.converted_unit_price, item.converted_currency)}</td>
                            <td className="px-3 py-2">{item.quantity}</td>
                            <td className="px-3 py-2 text-muted-foreground">{formatRate(item.exchange_rate_micros)}</td>
                          </tr>
                        )),
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-sm font-medium text-muted-foreground">تحويلات الدفعات</h3>
                <ExportCsvButton
                  filename="تحويلات-الدفعات.csv"
                  headers={["التاريخ", "الزبون", "المبلغ المدفوع", "حُوّل إلى", "سعر الصرف (د.ع لكل $1)"]}
                  rows={(paymentConversions ?? []).map((p) => [
                    p.payment_date,
                    p.customer_name,
                    formatMoney(p.amount_paid, p.payment_currency),
                    formatAmounts(p.converted_by_currency),
                    formatRate(p.exchange_rate_micros),
                  ])}
                />
              </div>
              {!paymentConversions && <p className="text-sm text-muted-foreground">جارٍ التحميل...</p>}
              {paymentConversions?.length === 0 && (
                <p className="text-sm text-muted-foreground">لا توجد دفعات جرى تحويل عملتها بهذه الفترة.</p>
              )}
              {paymentConversions && paymentConversions.length > 0 && (
                <div className="overflow-x-auto rounded-md border border-border">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50 text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2 text-right font-medium">التاريخ</th>
                        <th className="px-3 py-2 text-right font-medium">الزبون</th>
                        <th className="px-3 py-2 text-right font-medium">المبلغ المدفوع</th>
                        <th className="px-3 py-2 text-right font-medium">حُوّل إلى</th>
                        <th className="px-3 py-2 text-right font-medium">سعر الصرف (د.ع لكل $1)</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {paymentConversions.map((p) => (
                        <tr key={p.payment_id}>
                          <td className="px-3 py-2">{p.payment_date}</td>
                          <td
                            className="cursor-pointer px-3 py-2 hover:underline"
                            onClick={() => onSelectCustomer(p.customer_id)}
                          >
                            {p.customer_name}
                          </td>
                          <td className="px-3 py-2">{formatMoney(p.amount_paid, p.payment_currency)}</td>
                          <td className="px-3 py-2">{formatAmounts(p.converted_by_currency)}</td>
                          <td className="px-3 py-2 text-muted-foreground">{formatRate(p.exchange_rate_micros)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}

        {tab === "customers" && (
          <div>
            <div className="mb-2 flex items-center justify-end">
              <ExportCsvButton
                filename="تحويل-العملة-حسب-الزبون.csv"
                headers={["الزبون", "أجهزة محوَّلة (عدد)", "القيمة الأصلية", "القيمة بعد التحويل", "دفعات محوَّلة (عدد)", "المحوَّل من الدفعات"]}
                rows={(customerSummary ?? []).map((c) => [
                  c.customer_name,
                  c.item_conversion_count,
                  formatAmounts(c.item_original_value_by_currency),
                  formatAmounts(c.item_converted_value_by_currency),
                  c.payment_conversion_count,
                  formatAmounts(c.payment_converted_value_by_currency),
                ])}
              />
            </div>
            {!customerSummary && <p className="text-sm text-muted-foreground">جارٍ التحميل...</p>}
            {customerSummary?.length === 0 && (
              <p className="text-sm text-muted-foreground">لا توجد أي عمليات تحويل عملة حتى الآن.</p>
            )}
            {customerSummary && customerSummary.length > 0 && (
              <div className="overflow-x-auto rounded-md border border-border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 text-right font-medium">الزبون</th>
                      <th className="px-3 py-2 text-right font-medium">أجهزة محوَّلة (عدد)</th>
                      <th className="px-3 py-2 text-right font-medium">القيمة الأصلية</th>
                      <th className="px-3 py-2 text-right font-medium">القيمة بعد التحويل</th>
                      <th className="px-3 py-2 text-right font-medium">دفعات محوَّلة (عدد)</th>
                      <th className="px-3 py-2 text-right font-medium">المحوَّل من الدفعات</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {customerSummary.map((c) => (
                      <tr key={c.customer_id} className="cursor-pointer hover:bg-accent" onClick={() => onSelectCustomer(c.customer_id)}>
                        <td className="px-3 py-2 font-medium">{c.customer_name}</td>
                        <td className="px-3 py-2">{c.item_conversion_count}</td>
                        <td className="px-3 py-2">{formatAmounts(c.item_original_value_by_currency)}</td>
                        <td className="px-3 py-2">{formatAmounts(c.item_converted_value_by_currency)}</td>
                        <td className="px-3 py-2">{c.payment_conversion_count}</td>
                        <td className="px-3 py-2">{formatAmounts(c.payment_converted_value_by_currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {tab === "products" && (
          <div>
            <div className="mb-2 flex items-center justify-end">
              <ExportCsvButton
                filename="تحويل-العملة-حسب-الجهاز.csv"
                headers={["الجهاز", "مرات التحويل", "القيمة الأصلية", "القيمة بعد التحويل"]}
                rows={(productSummary ?? []).map((p) => [
                  p.product_name,
                  p.conversion_count,
                  formatAmounts(p.original_value_by_currency),
                  formatAmounts(p.converted_value_by_currency),
                ])}
              />
            </div>
            {!productSummary && <p className="text-sm text-muted-foreground">جارٍ التحميل...</p>}
            {productSummary?.length === 0 && (
              <p className="text-sm text-muted-foreground">لا توجد أجهزة بيعت بعملة مختلفة عن عملتها حتى الآن.</p>
            )}
            {productSummary && productSummary.length > 0 && (
              <div className="overflow-x-auto rounded-md border border-border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 text-right font-medium">الجهاز</th>
                      <th className="px-3 py-2 text-right font-medium">مرات التحويل</th>
                      <th className="px-3 py-2 text-right font-medium">القيمة الأصلية</th>
                      <th className="px-3 py-2 text-right font-medium">القيمة بعد التحويل</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {productSummary.map((p) => (
                      <tr key={p.product_id}>
                        <td className="px-3 py-2 font-medium">{p.product_name}</td>
                        <td className="px-3 py-2">{p.conversion_count}</td>
                        <td className="px-3 py-2">{formatAmounts(p.original_value_by_currency)}</td>
                        <td className="px-3 py-2">{formatAmounts(p.converted_value_by_currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        <p className="text-xs text-muted-foreground">
          يشمل هذا التقرير فقط الأجهزة والدفعات التي جرى فعلاً تحويل عملتها. السعر الأصلي لكل جهاز مُشتق من سعره
          المحوَّل المحفوظ في الفاتورة وسعر الصرف نفسه، بافتراض أن عملة الجهاز لم تتغيّر منذ البيع.
        </p>
      </CardContent>
    </Card>
  );
}
