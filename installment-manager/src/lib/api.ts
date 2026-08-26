import { invoke } from "@tauri-apps/api/core";

export type CurrencyCode = "IQD" | "USD";
export type MarkupType = "flat" | "percentage";
export type InstallmentStatus = "Pending" | "Partial" | "Paid";

export type LicenseStatus =
  | { state: "NotActivated" }
  | { state: "Valid"; customer_name: string; expires_at: string | null; issued_at: string; activated_at: string }
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
  guarantor_name: string | null;
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

export interface CustomerDocument {
  id: number;
  customer_id: number;
  file_name: string;
  mime_type: string;
  created_at: string;
  content_base64: string;
}

export interface CustomerDocumentMeta {
  id: number;
  customer_id: number;
  file_name: string;
  mime_type: string;
  created_at: string;
}

export function getCustomerDocuments(customerId: number): Promise<CustomerDocument[]> {
  return invoke("get_customer_documents", { customerId });
}

export function addCustomerDocument(payload: {
  customer_id: number;
  file_name: string;
  mime_type: string;
  content_base64: string;
}): Promise<CustomerDocumentMeta> {
  return invoke("add_customer_document", { payload });
}

export function deleteCustomerDocument(documentId: number): Promise<void> {
  return invoke("delete_customer_document", { documentId });
}

export function backupDatabase(destinationPath: string): Promise<void> {
  return invoke("backup_database", { destinationPath });
}

export function getOneDriveDir(): Promise<string | null> {
  return invoke("get_onedrive_dir");
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

export interface SaleConversionItem {
  product_id: number;
  product_name: string;
  original_currency: CurrencyCode;
  original_unit_price: number;
  converted_currency: CurrencyCode;
  converted_unit_price: number;
  quantity: number;
  exchange_rate_micros: number;
}

export interface SaleConversion {
  sale_id: number;
  sale_date: string;
  customer_id: number;
  customer_name: string;
  sale_currency: CurrencyCode;
  items: SaleConversionItem[];
}

export interface PaymentConversion {
  payment_id: number;
  payment_date: string;
  customer_id: number;
  customer_name: string;
  payment_currency: CurrencyCode;
  amount_paid: number;
  exchange_rate_micros: number;
  converted_by_currency: CurrencyAmount[];
}

export interface ProductConversionSummary {
  product_id: number;
  product_name: string;
  conversion_count: number;
  original_value_by_currency: CurrencyAmount[];
  converted_value_by_currency: CurrencyAmount[];
}

export interface CustomerConversionSummary {
  customer_id: number;
  customer_name: string;
  item_conversion_count: number;
  item_original_value_by_currency: CurrencyAmount[];
  item_converted_value_by_currency: CurrencyAmount[];
  payment_conversion_count: number;
  payment_converted_value_by_currency: CurrencyAmount[];
}

export function getSaleConversions(fromDate: string | null, toDate: string | null): Promise<SaleConversion[]> {
  return invoke("get_sale_conversions", { fromDate, toDate });
}

export function getPaymentConversions(fromDate: string | null, toDate: string | null): Promise<PaymentConversion[]> {
  return invoke("get_payment_conversions", { fromDate, toDate });
}

export function getProductConversionSummary(): Promise<ProductConversionSummary[]> {
  return invoke("get_product_conversion_summary");
}

export function getCustomerConversionSummary(): Promise<CustomerConversionSummary[]> {
  return invoke("get_customer_conversion_summary");
}
