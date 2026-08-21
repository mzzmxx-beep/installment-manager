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
