// Fetch-based client for the Cloudflare Worker API (cloud/api), replacing
// the original Tauri `invoke()` calls. Field names stay snake_case to
// match the Worker's wire format (see cloud/api/src/case.ts) -- every
// page below is otherwise unchanged from the original desktop app.
//
// IDs are UUID strings now instead of AUTOINCREMENT integers (see
// cloud/tenant-template/schema) -- every `id: number` from the original
// app is `id: string` here.

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "https://installment-api.mzzmxx.workers.dev";
const TOKEN_KEY = "auth_token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

/** Dispatched whenever a request comes back 401 -- the app shell listens for this to force a re-login. */
const UNAUTHORIZED_EVENT = "api:unauthorized";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  });

  if (res.status === 401) {
    clearToken();
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    throw new Error("انتهت الجلسة، الرجاء تسجيل الدخول مجدداً");
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error ?? `request failed (${res.status})`);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export function onUnauthorized(handler: () => void): () => void {
  window.addEventListener(UNAUTHORIZED_EVENT, handler);
  return () => window.removeEventListener(UNAUTHORIZED_EVENT, handler);
}

export async function login(email: string, password: string): Promise<void> {
  const { token } = await request<{ token: string }>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  setToken(token);
}

export function logout(): void {
  clearToken();
  window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
}

export type CurrencyCode = "IQD" | "USD";
export type MarkupType = "flat" | "percentage";
export type InstallmentStatus = "Pending" | "Partial" | "Paid";
export type InstallmentPeriodUnit = "months" | "days";

export interface Customer {
  id: string;
  name: string;
  phone: string | null;
  national_id: string;
  address: string | null;
  created_at: string;
}

export interface Product {
  id: string;
  name: string;
  reference_cash_price: number;
  currency_code: CurrencyCode;
  is_active: boolean;
}

export interface CreditSaleItem {
  id: string;
  sale_id: string;
  product_id: string;
  product_name: string;
  snapshot_cash_price: number;
  quantity: number;
}

export interface Installment {
  id: string;
  sale_id: string;
  due_date: string;
  scheduled_amount: number;
  allocated_amount: number;
  remaining_amount: number;
  status: InstallmentStatus;
}

export interface CreditSale {
  id: string;
  customer_id: string;
  guarantor_id: string | null;
  guarantor_name: string | null;
  sale_date: string;
  agreed_months: number;
  installment_period_unit: InstallmentPeriodUnit;
  applied_markup_value: number;
  total_installment_price: number;
  currency_code: CurrencyCode;
  manual_exchange_rate_micros: number;
  created_at: string;
  items: CreditSaleItem[];
  installments: Installment[];
}

export interface PaymentAllocation {
  id: string;
  payment_id: string;
  installment_id: string;
  allocated_amount: number;
}

export interface Payment {
  id: string;
  customer_id: string;
  payment_date: string;
  amount_paid: number;
  currency_code: CurrencyCode;
  manual_exchange_rate_micros: number;
  created_at: string;
  allocations: PaymentAllocation[];
  unallocated_amount: number;
}

export function getCustomers(searchTerm: string | null = null): Promise<Customer[]> {
  const query = searchTerm ? `?search=${encodeURIComponent(searchTerm)}` : "";
  return request(`/api/customers${query}`);
}

export function createCustomer(payload: {
  name: string;
  phone: string | null;
  national_id: string;
  address: string | null;
}): Promise<Customer> {
  return request("/api/customers", { method: "POST", body: JSON.stringify(payload) });
}

export function getActiveProducts(): Promise<Product[]> {
  return request("/api/products");
}

export function createProduct(payload: {
  name: string;
  reference_cash_price: number;
  currency_code: CurrencyCode;
}): Promise<Product> {
  return request("/api/products", { method: "POST", body: JSON.stringify(payload) });
}

export function createCreditSale(payload: {
  customer_id: string;
  guarantor_id: string | null;
  sale_date: string;
  items: { product_id: string; quantity: number }[];
  markup_type: MarkupType;
  markup_input: number;
  agreed_months: number;
  installment_period_unit: InstallmentPeriodUnit;
  currency_code: CurrencyCode;
  manual_exchange_rate_micros: number;
}): Promise<CreditSale> {
  return request("/api/sales", { method: "POST", body: JSON.stringify(payload) });
}

export function getSalesForCustomer(customerId: string): Promise<CreditSale[]> {
  return request(`/api/customers/${customerId}/sales`);
}

export function registerPayment(payload: {
  customer_id: string;
  sale_id: string | null;
  payment_date: string;
  amount_paid: number;
  currency_code: CurrencyCode;
  manual_exchange_rate_micros: number;
}): Promise<Payment> {
  return request("/api/payments", { method: "POST", body: JSON.stringify(payload) });
}

export interface CurrencyBalance {
  currency_code: CurrencyCode;
  total_remaining: number;
}

export interface CustomerStatement {
  customer: Customer;
  sales: CreditSale[];
  payments: Payment[];
  balances: CurrencyBalance[];
}

export interface OverdueInstallment {
  installment_id: string;
  sale_id: string;
  customer_id: string;
  customer_name: string;
  due_date: string;
  days_overdue: number;
  currency_code: CurrencyCode;
  scheduled_amount: number;
  remaining_amount: number;
}

export function getCustomerStatement(customerId: string): Promise<CustomerStatement> {
  return request(`/api/customers/${customerId}/statement`);
}

export function getOverdueInstallments(currentDate: string): Promise<OverdueInstallment[]> {
  return request(`/api/reports/overdue-installments?date=${currentDate}`);
}

export interface CurrencyAmount {
  currency_code: CurrencyCode;
  amount: number;
}

export interface SalesSummary {
  currency_code: CurrencyCode;
  sale_count: number;
  total_cash_value: number;
  total_markup: number;
  total_installment_value: number;
  total_collected: number;
  total_outstanding: number;
}

export interface ProductSales {
  product_id: string;
  product_name: string;
  total_quantity: number;
  revenue_by_currency: CurrencyAmount[];
}

export interface CustomerRanking {
  customer_id: string;
  customer_name: string;
  sale_count: number;
  total_purchased_by_currency: CurrencyAmount[];
}

export interface CustomerOverdueRanking {
  customer_id: string;
  customer_name: string;
  overdue_installment_count: number;
  max_days_overdue: number;
  overdue_amount_by_currency: CurrencyAmount[];
}

export interface CustomerOverview {
  customer_id: string;
  customer_name: string;
  sale_count: number;
  total_purchased_by_currency: CurrencyAmount[];
  total_remaining_by_currency: CurrencyAmount[];
  last_sale_date: string | null;
}

function dateRangeQuery(fromDate: string | null, toDate: string | null): string {
  const params = new URLSearchParams();
  if (fromDate) params.set("from", fromDate);
  if (toDate) params.set("to", toDate);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export function getSalesSummary(fromDate: string | null, toDate: string | null): Promise<SalesSummary[]> {
  return request(`/api/reports/sales-summary${dateRangeQuery(fromDate, toDate)}`);
}

export function getTopProducts(limit: number): Promise<ProductSales[]> {
  return request(`/api/reports/top-products?limit=${limit}`);
}

export function getTopCustomers(limit: number): Promise<CustomerRanking[]> {
  return request(`/api/reports/top-customers?limit=${limit}`);
}

export function getMostOverdueCustomers(currentDate: string, limit: number): Promise<CustomerOverdueRanking[]> {
  return request(`/api/reports/most-overdue-customers?date=${currentDate}&limit=${limit}`);
}

export function getCustomersOverview(): Promise<CustomerOverview[]> {
  return request("/api/reports/customers-overview");
}

export interface SaleConversionItem {
  product_id: string;
  product_name: string;
  original_currency: CurrencyCode;
  original_unit_price: number;
  converted_currency: CurrencyCode;
  converted_unit_price: number;
  quantity: number;
  exchange_rate_micros: number;
}

export interface SaleConversion {
  sale_id: string;
  sale_date: string;
  customer_id: string;
  customer_name: string;
  sale_currency: CurrencyCode;
  items: SaleConversionItem[];
}

export interface PaymentConversion {
  payment_id: string;
  payment_date: string;
  customer_id: string;
  customer_name: string;
  payment_currency: CurrencyCode;
  amount_paid: number;
  exchange_rate_micros: number;
  converted_by_currency: CurrencyAmount[];
}

export interface ProductConversionSummary {
  product_id: string;
  product_name: string;
  conversion_count: number;
  original_value_by_currency: CurrencyAmount[];
  converted_value_by_currency: CurrencyAmount[];
}

export interface CustomerConversionSummary {
  customer_id: string;
  customer_name: string;
  item_conversion_count: number;
  item_original_value_by_currency: CurrencyAmount[];
  item_converted_value_by_currency: CurrencyAmount[];
  payment_conversion_count: number;
  payment_converted_value_by_currency: CurrencyAmount[];
}

export function getSaleConversions(fromDate: string | null, toDate: string | null): Promise<SaleConversion[]> {
  return request(`/api/reports/sale-conversions${dateRangeQuery(fromDate, toDate)}`);
}

export function getPaymentConversions(fromDate: string | null, toDate: string | null): Promise<PaymentConversion[]> {
  return request(`/api/reports/payment-conversions${dateRangeQuery(fromDate, toDate)}`);
}

export function getProductConversionSummary(): Promise<ProductConversionSummary[]> {
  return request("/api/reports/product-conversion-summary");
}

export function getCustomerConversionSummary(): Promise<CustomerConversionSummary[]> {
  return request("/api/reports/customer-conversion-summary");
}
