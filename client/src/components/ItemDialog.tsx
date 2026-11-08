import { useState } from "react";
import { ApiError, type Item, type ItemInput } from "@/lib/api";

export function ItemDialog({
  item,
  categories,
  onClose,
  onSubmit,
}: {
  item: Item | null;
  categories: string[];
  onClose: () => void;
  onSubmit: (d: ItemInput) => Promise<unknown>;
}) {
  const [f, setF] = useState<ItemInput>({
    title: item?.title ?? "",
    price: item?.price ?? "",
    category: item?.category ?? categories[0] ?? "",
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit(f);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4" onClick={onClose}>
      <form onClick={(e) => e.stopPropagation()} onSubmit={submit} className="card-light w-full max-w-md space-y-4 p-8">
        <h2 className="font-display text-2xl">{item ? `Item #${item.id}` : "Новый item"}</h2>
        <label className="block space-y-1 text-sm">
          <span>title</span>
          <input className="w-full rounded-full border px-4 py-2" style={{ borderColor: "var(--muted-foreground)" }} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} maxLength={255} required />
        </label>
        <label className="block space-y-1 text-sm">
          <span>price</span>
          <input className="w-full rounded-full border px-4 py-2" style={{ borderColor: "var(--muted-foreground)" }} value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} inputMode="decimal" placeholder="12.50" required />
        </label>
        <label className="block space-y-1 text-sm">
          <span>category</span>
          <select className="w-full rounded-full border px-4 py-2" style={{ borderColor: "var(--muted-foreground)" }} value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
            {categories.map((c) => <option key={c}>{c}</option>)}
          </select>
        </label>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex gap-2 pt-2">
          <button disabled={busy} className="rounded-full bg-primary px-6 py-2 font-medium text-primary-foreground disabled:opacity-50">
            {busy ? "Сохраняю…" : "Сохранить"}
          </button>
          <button type="button" onClick={onClose} className="rounded-full px-6 py-2">Отмена</button>
        </div>
      </form>
    </div>
  );
}
