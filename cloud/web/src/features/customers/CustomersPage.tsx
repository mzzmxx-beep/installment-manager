import { useEffect, useState } from "react";
import { createCustomer, getCustomers, type Customer } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function CustomersPage({ onSelectCustomer }: { onSelectCustomer: (id: string) => void }) {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", phone: "", nationalId: "", address: "" });
  const [submitting, setSubmitting] = useState(false);

  async function load(term: string) {
    try {
      setCustomers(await getCustomers(term || null));
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    load(search);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    await load(search);
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await createCustomer({
        name: form.name,
        phone: form.phone || null,
        national_id: form.nationalId,
        address: form.address || null,
      });
      setForm({ name: "", phone: "", nationalId: "", address: "" });
      await load(search);
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
          <CardTitle>العملاء</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <form onSubmit={handleSearch} className="flex gap-2">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="بحث بالاسم أو الرقم الوطني"
            />
            <Button type="submit" variant="outline">
              بحث
            </Button>
          </form>

          <div className="divide-y divide-border rounded-md border border-border">
            {customers.map((c) => (
              <button
                key={c.id}
                onClick={() => onSelectCustomer(c.id)}
                className="flex w-full flex-col items-start gap-0.5 px-4 py-3 text-right hover:bg-accent"
              >
                <span className="font-medium">{c.name}</span>
                <span className="text-sm text-muted-foreground">
                  {c.national_id}
                  {c.phone ? ` · ${c.phone}` : ""}
                </span>
              </button>
            ))}
            {customers.length === 0 && (
              <div className="px-4 py-3 text-sm text-muted-foreground">لا يوجد عملاء بعد.</div>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>إضافة عميل جديد</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleCreate} className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="c-name">الاسم</Label>
              <Input
                id="c-name"
                required
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="c-national-id">الرقم الوطني</Label>
              <Input
                id="c-national-id"
                required
                value={form.nationalId}
                onChange={(e) => setForm({ ...form, nationalId: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="c-phone">الهاتف</Label>
              <Input
                id="c-phone"
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="c-address">العنوان</Label>
              <Input
                id="c-address"
                value={form.address}
                onChange={(e) => setForm({ ...form, address: e.target.value })}
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" disabled={submitting}>
              إضافة عميل
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
