import { useEffect, useMemo, useState } from "react";
import {
  createCreditSale,
  getActiveProducts,
  getCustomers,
  getGuarantors,
  type CurrencyCode,
  type Customer,
  type Guarantor,
  type MarkupType,
  type Product,
} from "@/lib/api";
import { formatMoney, todayIso, toStorageAmount } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";

interface ItemRow {
  productId: string;
  quantity: string;
}

export function NewSalePage({ onCreated }: { onCreated: (customerId: number) => void }) {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [guarantors, setGuarantors] = useState<Guarantor[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [customerId, setCustomerId] = useState("");
  const [guarantorId, setGuarantorId] = useState("");
  const [saleDate, setSaleDate] = useState(todayIso());
  const [currency, setCurrency] = useState<CurrencyCode>("IQD");
  const [items, setItems] = useState<ItemRow[]>([{ productId: "", quantity: "1" }]);
  const [markupType, setMarkupType] = useState<MarkupType>("percentage");
  const [markupInput, setMarkupInput] = useState("0");
  const [agreedMonths, setAgreedMonths] = useState("6");
  const [exchangeRate, setExchangeRate] = useState("1");

  useEffect(() => {
    getCustomers().then(setCustomers).catch((e) => setError(String(e)));
    getGuarantors().then(setGuarantors).catch((e) => setError(String(e)));
    getActiveProducts().then(setProducts).catch((e) => setError(String(e)));
  }, []);

  const availableProducts = useMemo(
    () => products.filter((p) => p.currency_code === currency),
    [products, currency],
  );

  const cashTotal = useMemo(
    () =>
      items.reduce((sum, item) => {
        const product = availableProducts.find((p) => String(p.id) === item.productId);
        const qty = Number(item.quantity) || 0;
        return sum + (product ? product.reference_cash_price * qty : 0);
      }, 0),
    [items, availableProducts],
  );

  const markupValue = useMemo(() => {
    if (markupType === "flat") return toStorageAmount(markupInput, currency);
    const percent = Number(markupInput) || 0;
    return Math.round((cashTotal * percent) / 100);
  }, [markupType, markupInput, currency, cashTotal]);

  const total = cashTotal + markupValue;
  const months = Number(agreedMonths) || 0;
  const approxInstallment = months > 0 ? Math.floor(total / months) : 0;

  function updateItem(index: number, patch: Partial<ItemRow>) {
    setItems((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  function addItemRow() {
    setItems((prev) => [...prev, { productId: "", quantity: "1" }]);
  }

  function removeItemRow(index: number) {
    setItems((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const validItems = items
      .filter((row) => row.productId)
      .map((row) => ({ product_id: Number(row.productId), quantity: Number(row.quantity) || 0 }));

    if (!customerId) {
      setError("اختر الزبون أولاً");
      return;
    }
    if (validItems.length === 0) {
      setError("أضف منتجاً واحداً على الأقل");
      return;
    }
    if (months <= 0) {
      setError("عدد الأقساط يجب أن يكون أكبر من صفر");
      return;
    }

    setSubmitting(true);
    try {
      await createCreditSale({
        customer_id: Number(customerId),
        guarantor_id: guarantorId ? Number(guarantorId) : null,
        sale_date: saleDate,
        items: validItems,
        markup_type: markupType,
        markup_input: markupType === "flat" ? toStorageAmount(markupInput, currency) : Math.round((Number(markupInput) || 0) * 100),
        agreed_months: months,
        currency_code: currency,
        manual_exchange_rate_micros: Math.round((Number(exchangeRate) || 0) * 1_000_000),
      });
      onCreated(Number(customerId));
    } catch (e) {
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
      <Card>
        <CardHeader>
          <CardTitle>بيع بالتقسيط جديد</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="s-customer">الزبون</Label>
                <Select id="s-customer" required value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
                  <option value="">اختر الزبون</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="s-guarantor">الكفيل (اختياري)</Label>
                <Select id="s-guarantor" value={guarantorId} onChange={(e) => setGuarantorId(e.target.value)}>
                  <option value="">بدون كفيل</option>
                  {guarantors.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="s-date">تاريخ البيع</Label>
                <Input id="s-date" type="date" required value={saleDate} onChange={(e) => setSaleDate(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="s-currency">العملة</Label>
                <Select id="s-currency" value={currency} onChange={(e) => setCurrency(e.target.value as CurrencyCode)}>
                  <option value="IQD">دينار عراقي (IQD)</option>
                  <option value="USD">دولار أمريكي (USD)</option>
                </Select>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <Label>المنتجات</Label>
              {items.map((row, index) => (
                <div key={index} className="flex items-center gap-2">
                  <Select
                    className="flex-1"
                    value={row.productId}
                    onChange={(e) => updateItem(index, { productId: e.target.value })}
                  >
                    <option value="">اختر منتجاً</option>
                    {availableProducts.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} — {formatMoney(p.reference_cash_price, p.currency_code)}
                      </option>
                    ))}
                  </Select>
                  <Input
                    type="number"
                    min="1"
                    className="w-20"
                    value={row.quantity}
                    onChange={(e) => updateItem(index, { quantity: e.target.value })}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={items.length === 1}
                    onClick={() => removeItemRow(index)}
                  >
                    حذف
                  </Button>
                </div>
              ))}
              <Button type="button" variant="outline" size="sm" onClick={addItemRow} className="self-start">
                + إضافة منتج
              </Button>
              {availableProducts.length === 0 && (
                <p className="text-sm text-muted-foreground">لا يوجد منتجات بعملة {currency}.</p>
              )}
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="s-markup-type">نوع الهامش</Label>
                <Select id="s-markup-type" value={markupType} onChange={(e) => setMarkupType(e.target.value as MarkupType)}>
                  <option value="percentage">نسبة مئوية</option>
                  <option value="flat">مبلغ مقطوع</option>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="s-markup-input">
                  {markupType === "percentage" ? "النسبة %" : "المبلغ"}
                </Label>
                <Input
                  id="s-markup-input"
                  type="number"
                  min="0"
                  step="0.01"
                  value={markupInput}
                  onChange={(e) => setMarkupInput(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="s-months">عدد الأقساط (أشهر)</Label>
                <Input
                  id="s-months"
                  type="number"
                  min="1"
                  required
                  value={agreedMonths}
                  onChange={(e) => setAgreedMonths(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="s-rate">سعر الصرف اليدوي</Label>
                <Input
                  id="s-rate"
                  type="number"
                  min="0"
                  step="0.000001"
                  required
                  value={exchangeRate}
                  onChange={(e) => setExchangeRate(e.target.value)}
                />
              </div>
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <Button type="submit" disabled={submitting}>
              إنشاء البيع
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card className="h-fit">
        <CardHeader>
          <CardTitle>معاينة</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">السعر النقدي</span>
            <span>{formatMoney(cashTotal, currency)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">الهامش</span>
            <span>{formatMoney(markupValue, currency)}</span>
          </div>
          <div className="flex justify-between border-t border-border pt-2 font-medium">
            <span>الإجمالي بالتقسيط</span>
            <span>{formatMoney(total, currency)}</span>
          </div>
          <div className="flex justify-between text-muted-foreground">
            <span>القسط التقريبي / شهر</span>
            <span>{formatMoney(approxInstallment, currency)}</span>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            القيم النهائية تُحسب من الخادم عند الحفظ (يضاف الباقي الكسري إلى آخر قسط).
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
