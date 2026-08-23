import { invoke } from "@tauri-apps/api/core";

export type CurrencyCode = "IQD" | "USD";
export type MarkupType = "flat" | "percentage";
export type InstallmentStatus = "Pending" | "Partial" | "Paid";

export type LicenseStatus =
  | { state: "NotActivated" }
  | { state: "Valid"; customer_name: string; expires_at: string | null }
  | { state: "Expired"; customer_name: string; expires_at: string }
  | { state: "Invalid"; reason: string }
  | { state: "ClockRollbackDetected" };

export interface Customer {
  id: number;
  name: string;
  phone: string | null;
  national_id: string;
  address: string | null;
  created_at: string;
}

export interface Product {
  id: number;
  name: string;
  reference_cash_price: number;
  currency_code: CurrencyCode;
  is_active: boolean;
}

export interface CreditSaleItem {
  id: number;
  sale_id: number;
  product_id: number;
  product_name: string;
  snapshot_cash_price: number;
  quantity: number;
}

export interface Installment {
  id: number;
  sale_id: number;
  due_date: string;
  scheduled_amount: number;
  allocated_amount: number;
  remaining_amount: number;
  status: InstallmentStatus;
}

export interface CreditSale {
  id: number;
  customer_id: number;
  guarantor_id: number | null;
  sale_date: string;
  agreed_months: number;
  applied_markup_value: number;
  total_installment_price: number;
  currency_code: CurrencyCode;
  manual_exchange_rate_micros: number;
  created_at: string;
  items: CreditSaleItem[];
  installments: Installment[];
}

export interface PaymentAllocation {
  id: number;
  payment_id: number;
  installment_id: number;
  allocated_amount: number;
}

export interface Payment {
  id: number;
  customer_id: number;
  payment_date: string;
  amount_paid: number;
  currency_code: CurrencyCode;
  manual_exchange_rate_micros: number;
  created_at: string;
  allocations: PaymentAllocation[];
  unallocated_amount: number;
}

export function getCustomers(searchTerm: string | null = null): Promise<Customer[]> {
  return invoke("get_customers", { searchTerm });
}

export function createCustomer(payload: {
  name: string;
  phone: string | null;
  national_id: string;
  address: string | null;
}): Promise<Customer> {
  return invoke("create_customer", { payload });
}

export function getActiveProducts(): Promise<Product[]> {
  return invoke("get_active_products");
}

export function createProduct(payload: {
  name: string;
  reference_cash_price: number;
  currency_code: CurrencyCode;
}): Promise<Product> {
  return invoke("create_product", { payload });
}

export function createCreditSale(payload: {
  customer_id: number;
  guarantor_id: number | null;
  sale_date: string;
  items: { product_id: number; quantity: number }[];
  markup_type: MarkupType;
  markup_input: number;
  agreed_months: number;
  currency_code: CurrencyCode;
  manual_exchange_rate_micros: number;
}): Promise<CreditSale> {
  return invoke("create_credit_sale", { payload });
}

export function getSalesForCustomer(customerId: number): Promise<CreditSale[]> {
  return invoke("get_sales_for_customer", { customerId });
}

export function registerPayment(payload: {
  customer_id: number;
  sale_id: number | null;
  payment_date: string;
  amount_paid: number;
  currency_code: CurrencyCode;
  manual_exchange_rate_micros: number;
}): Promise<Payment> {
  return invoke("register_payment", { payload });
}

export function validateLicense(): Promise<LicenseStatus> {
  return invoke("validate_license");
}

export function activateLicense(licenseKey: string): Promise<LicenseStatus> {
  return invoke("activate_license", { payload: { license_key: licenseKey } });
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
  installment_id: number;
  sale_id: number;
  customer_id: number;
  customer_name: string;
  due_date: string;
  days_overdue: number;
  currency_code: CurrencyCode;
  scheduled_amount: number;
  remaining_amount: number;
}

export function getCustomerStatement(customerId: number): Promise<CustomerStatement> {
  return invoke("get_customer_statement", { customerId });
}

export function getOverdueInstallments(currentDate: string): Promise<OverdueInstallment[]> {
  return invoke("get_overdue_installments", { currentDate });
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
  product_id: number;
  product_name: string;
  total_quantity: number;
  revenue_by_currency: CurrencyAmount[];
}

export interface CustomerRanking {
  customer_id: number;
  customer_name: string;
  sale_count: number;
  total_purchased_by_currency: CurrencyAmount[];
}

export interface CustomerOverdueRanking {
  customer_id: number;
  customer_name: string;
  overdue_installment_count: number;
  max_days_overdue: number;
  overdue_amount_by_currency: CurrencyAmount[];
}

export interface CustomerOverview {
  customer_id: number;
  customer_name: string;
  sale_count: number;
  total_purchased_by_currency: CurrencyAmount[];
  total_remaining_by_currency: CurrencyAmount[];
  last_sale_date: string | null;
}

export function getSalesSummary(fromDate: string | null, toDate: string | null): Promise<SalesSummary[]> {
  return invoke("get_sales_summary", { fromDate, toDate });
}

export function getTopProducts(limit: number): Promise<ProductSales[]> {
  return invoke("get_top_products", { limit });
}

export function getTopCustomers(limit: number): Promise<CustomerRanking[]> {
  return invoke("get_top_customers", { limit });
}

export function getMostOverdueCustomers(currentDate: string, limit: number): Promise<CustomerOverdueRanking[]> {
  return invoke("get_most_overdue_customers", { currentDate, limit });
}

export function getCustomersOverview(): Promise<CustomerOverview[]> {
  return invoke("get_customers_overview");
}
