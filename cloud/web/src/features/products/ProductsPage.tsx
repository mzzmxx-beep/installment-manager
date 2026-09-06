import { useEffect, useState } from "react";
import { createProduct, getActiveProducts, type CurrencyCode, type Product } from "@/lib/api";
import { formatMoney, toStorageAmount } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";

export function ProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({ name: "", price: "", currency: "IQD" as CurrencyCode });

  async function load() {
    try {
      setProducts(await getActiveProducts());
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await createProduct({
        name: form.name,
        reference_cash_price: toStorageAmount(form.price, form.currency),
        currency_code: form.currency,
      });
      setForm({ name: "", price: "", currency: form.currency });
      await load();
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
          <CardTitle>المنتجات</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="divide-y divide-border rounded-md border border-border">
            {products.map((p) => (
              <div key={p.id} className="flex items-center justify-between px-4 py-3">
                <span className="font-medium">{p.name}</span>
                <span className="text-sm text-muted-foreground">
                  {formatMoney(p.reference_cash_price, p.currency_code)}
                </span>
              </div>
            ))}
            {products.length === 0 && (
              <div className="px-4 py-3 text-sm text-muted-foreground">لا يوجد منتجات بعد.</div>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>إضافة منتج</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleCreate} className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="p-name">اسم المنتج</Label>
              <Input
                id="p-name"
                required
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="p-price">السعر النقدي المرجعي</Label>
              <Input
                id="p-price"
                type="number"
                min="0"
                step="0.01"
                required
                value={form.price}
                onChange={(e) => setForm({ ...form, price: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="p-currency">العملة</Label>
              <Select
                id="p-currency"
                value={form.currency}
                onChange={(e) => setForm({ ...form, currency: e.target.value as CurrencyCode })}
              >
                <option value="IQD">دينار عراقي (IQD)</option>
                <option value="USD">دولار أمريكي (USD)</option>
              </Select>
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" disabled={submitting}>
              إضافة منتج
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
