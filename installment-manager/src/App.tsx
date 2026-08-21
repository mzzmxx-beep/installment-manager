import { useState } from "react";
import { CustomerDetail } from "@/features/customers/CustomerDetail";
import { CustomersPage } from "@/features/customers/CustomersPage";
import { LicenseGate } from "@/features/license/LicenseGate";
import { ProductsPage } from "@/features/products/ProductsPage";
import { CustomerStatement } from "@/features/reporting/CustomerStatement";
import { OverduePage } from "@/features/reporting/OverduePage";
import { NewSalePage } from "@/features/sales/NewSalePage";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type View =
  | { tab: "customers" }
  | { tab: "products" }
  | { tab: "new-sale" }
  | { tab: "overdue" }
  | { tab: "customer-detail"; customerId: number }
  | { tab: "customer-statement"; customerId: number };

const TABS: { tab: "customers" | "products" | "new-sale" | "overdue"; label: string }[] = [
  { tab: "customers", label: "العملاء" },
  { tab: "products", label: "المنتجات" },
  { tab: "new-sale", label: "بيع جديد" },
  { tab: "overdue", label: "المتأخرات" },
];

function App() {
  const [view, setView] = useState<View>({ tab: "customers" });

  // The statement is a standalone printable page, deliberately outside the
  // normal header/nav shell so nothing but the statement itself can print.
  if (view.tab === "customer-statement") {
    return (
      <LicenseGate>
        <CustomerStatement customerId={view.customerId} onBack={() => setView({ tab: "customer-detail", customerId: view.customerId })} />
      </LicenseGate>
    );
  }

  const activeTab = view.tab === "customer-detail" ? "customers" : view.tab;

  return (
    <LicenseGate>
      <div dir="rtl" className="min-h-screen bg-background text-right">
        <header className="border-b border-border">
          <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
            <h1 className="text-xl font-semibold">إدارة الأقساط</h1>
            <nav className="flex gap-1">
              {TABS.map((t) => (
                <Button
                  key={t.tab}
                  variant="ghost"
                  className={cn(activeTab === t.tab && "bg-accent text-accent-foreground")}
                  onClick={() => setView({ tab: t.tab })}
                >
                  {t.label}
                </Button>
              ))}
            </nav>
          </div>
        </header>

        <main className="mx-auto max-w-5xl px-6 py-8">
          {view.tab === "customers" && (
            <CustomersPage onSelectCustomer={(id) => setView({ tab: "customer-detail", customerId: id })} />
          )}
          {view.tab === "products" && <ProductsPage />}
          {view.tab === "new-sale" && (
            <NewSalePage onCreated={(customerId) => setView({ tab: "customer-detail", customerId })} />
          )}
          {view.tab === "overdue" && (
            <OverduePage onSelectCustomer={(id) => setView({ tab: "customer-detail", customerId: id })} />
          )}
          {view.tab === "customer-detail" && (
            <CustomerDetail
              customerId={view.customerId}
              onBack={() => setView({ tab: "customers" })}
              onViewStatement={() => setView({ tab: "customer-statement", customerId: view.customerId })}
            />
          )}
        </main>
      </div>
    </LicenseGate>
  );
}

export default App;
