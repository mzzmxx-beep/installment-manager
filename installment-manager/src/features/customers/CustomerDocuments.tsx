import { useEffect, useRef, useState } from "react";
import {
  addCustomerDocument,
  deleteCustomerDocument,
  getCustomerDocuments,
  type CustomerDocument,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("failed to read file"));
    reader.readAsDataURL(file);
  });
}

/** A viewable, browsable photo gallery for one customer's document photos
 * ("مستمسكات") — national ID, contract pages, etc. Images are stored as
 * base64 and round-trip through the Rust backend as a SQLite BLOB; there
 * is no separate file storage to keep in sync. */
export function CustomerDocuments({ customerId }: { customerId: number }) {
  const [documents, setDocuments] = useState<CustomerDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function load() {
    try {
      setDocuments(await getCustomerDocuments(customerId));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setLoading(true);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId]);

  useEffect(() => {
    if (viewerIndex === null) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setViewerIndex(null);
      else if (e.key === "ArrowLeft") setViewerIndex((i) => (i === null ? i : (i + 1) % documents.length));
      else if (e.key === "ArrowRight") setViewerIndex((i) => (i === null ? i : (i - 1 + documents.length) % documents.length));
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [viewerIndex, documents.length]);

  async function handleFilesSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length === 0) return;
    setError(null);
    setUploading(true);
    try {
      for (const file of files) {
        const content_base64 = await readFileAsBase64(file);
        await addCustomerDocument({
          customer_id: customerId,
          file_name: file.name,
          mime_type: file.type || "image/jpeg",
          content_base64,
        });
      }
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setUploading(false);
    }
  }

  async function handleDelete(doc: CustomerDocument) {
    if (!window.confirm(`حذف الصورة "${doc.file_name}"؟`)) return;
    setError(null);
    try {
      await deleteCustomerDocument(doc.id);
      setViewerIndex(null);
      await load();
    } catch (e) {
      setError(String(e));
    }
  }

  const viewerDoc = viewerIndex !== null ? documents[viewerIndex] : null;

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>مستمسكات الزبون</CardTitle>
        <div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={handleFilesSelected}
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
          >
            {uploading ? "جارِ الرفع..." : "+ إضافة صورة"}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {error && <p className="mb-3 text-sm text-destructive">{error}</p>}
        {loading ? (
          <p className="text-sm text-muted-foreground">جارِ التحميل...</p>
        ) : documents.length === 0 ? (
          <p className="text-sm text-muted-foreground">لا توجد صور مستمسكات لهذا العميل بعد.</p>
        ) : (
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6">
            {documents.map((doc, i) => (
              <button
                key={doc.id}
                type="button"
                onClick={() => setViewerIndex(i)}
                className="aspect-square overflow-hidden rounded-md border border-border bg-muted transition-opacity hover:opacity-80"
              >
                <img
                  src={`data:${doc.mime_type};base64,${doc.content_base64}`}
                  alt={doc.file_name}
                  className="h-full w-full object-cover"
                />
              </button>
            ))}
          </div>
        )}
      </CardContent>

      {viewerDoc && (
        <div
          className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-black/80 p-6"
          onClick={() => setViewerIndex(null)}
        >
          <div
            className="flex max-h-full max-w-full flex-col items-center gap-3"
            onClick={(e) => e.stopPropagation()}
          >
            <img
              src={`data:${viewerDoc.mime_type};base64,${viewerDoc.content_base64}`}
              alt={viewerDoc.file_name}
              className="max-h-[75vh] max-w-[85vw] rounded-md object-contain"
            />
            <div className="flex items-center gap-3 text-sm text-white">
              <span>{viewerDoc.file_name}</span>
              <span className="text-white/60">{viewerDoc.created_at.slice(0, 10)}</span>
              {documents.length > 1 && (
                <span className="text-white/60">
                  {viewerIndex! + 1} / {documents.length}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {documents.length > 1 && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setViewerIndex((i) => (i === null ? i : (i + 1) % documents.length))}
                >
                  السابق
                </Button>
              )}
              <Button type="button" variant="destructive" size="sm" onClick={() => handleDelete(viewerDoc)}>
                حذف
              </Button>
              {documents.length > 1 && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setViewerIndex((i) => (i === null ? i : (i - 1 + documents.length) % documents.length))}
                >
                  التالي
                </Button>
              )}
              <Button type="button" variant="ghost" size="sm" onClick={() => setViewerIndex(null)}>
                إغلاق ×
              </Button>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
