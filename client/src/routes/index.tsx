import { createFileRoute } from "@tanstack/react-router";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, baseUrl, BACKENDS, type BackendId, type Item, type ItemInput, type SortKey } from "@/lib/api";
import { useBackend } from "@/lib/backend";
import heroImg from "@/assets/hero-servers.jpg";
import { ItemDialog } from "@/components/ItemDialog";
import { CompareRun, REAL_BACKENDS } from "@/components/CompareRun";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Items — Polyglot Backend Benchmark" },
      { name: "description", content: "CRUD по items с переключением между Go, Node, PHP и Python бэкендами." },
      { property: "og:title", content: "Items — Polyglot Backend Benchmark" },
      { property: "og:description", content: "Один контракт, четыре бэкенда: Go, Node, PHP, Python." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: ItemsPage,
});

const LIMIT = 20;

function ItemsPage() {
  const { backend, setBackend } = useBackend();
  const qc = useQueryClient();
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [sort, setSort] = useState<SortKey>("-created_at");
  const [offset, setOffset] = useState(0);
  const [editing, setEditing] = useState<Item | null | undefined>(undefined);
  const [compareOpen, setCompareOpen] = useState(false);
  const [compareNonce, setCompareNonce] = useState(0);
  const [alive, setAlive] = useState<BackendId[]>([]);

  useEffect(() => {
    Promise.allSettled(REAL_BACKENDS.map((b) => api.health(b))).then((rs) =>
      setAlive(REAL_BACKENDS.filter((_, i) => rs[i]!.status === "fulfilled")),
    );
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(searchInput.trim());
      setOffset(0);
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const health = useQuery({ queryKey: [backend, "health"], queryFn: () => api.health(backend), retry: 0, refetchInterval: 15000 });
  const stats = useQuery({ queryKey: [backend, "stats"], queryFn: () => api.stats(backend) });
  const q = { limit: LIMIT, offset, sort, category: category || undefined, search: search || undefined };
  const list = useQuery({ queryKey: [backend, "items", q], queryFn: () => api.list(backend, q), placeholderData: keepPreviousData });

  const invalidate = () => qc.invalidateQueries({ queryKey: [backend] });
  const save = useMutation({
    mutationFn: (d: ItemInput) => (editing ? api.update(backend, editing.id, d) : api.create(backend, d)),
    onSuccess: invalidate,
  });
  const del = useMutation({ mutationFn: (id: number) => api.remove(backend, id), onSuccess: invalidate });

  const categories = stats.data?.stats.map((s) => s.category) ?? [];
  const total = list.data?.total ?? 0;
  const label = BACKENDS.find((b) => b.id === backend)?.label;
  const toggleSort = (k: "created_at" | "price") => setSort(sort === `-${k}` ? k : (`-${k}` as SortKey));
  const arrow = (k: string) => (sort === k ? " ↑" : sort === `-${k}` ? " ↓" : "");

  return (
    <div className="space-y-8">
      <section className="grid gap-4 md:grid-cols-[2fr_1fr]">
        <div className="card-light relative overflow-hidden p-8 md:p-10">
          <svg viewBox="0 0 100 100" className="hero-star absolute -right-16 -top-16 h-72 w-72 text-primary" aria-hidden>
            <path fill="currentColor" d="M50 0l6 34 28-20-20 28 36 8-36 8 20 28-28-20-6 36-6-36-28 20 20-28L0 50l36-8L16 14l28 20z" />
          </svg>
          <div className="relative flex flex-wrap gap-2">
            {BACKENDS.filter((b) => b.id !== "demo").map((b) => (
              <button
                key={b.id}
                type="button"
                aria-pressed={b.id === backend}
                onClick={() => setBackend(b.id)}
                className={`rounded-full border px-3 py-1 text-xs font-medium ${b.id === backend ? "border-transparent bg-card-foreground text-card" : ""}`}
                style={b.id === backend ? undefined : { borderColor: "currentColor" }}
              >
                {b.label}{b.port ? ` :${b.port}` : ""}
              </button>
            ))}
          </div>
          <h1 className="relative mt-16 font-display text-5xl font-bold leading-[0.95] md:text-7xl">
            polyglot<br /><span className="text-primary">{label}</span>
          </h1>
          <p className="relative mt-5 max-w-sm text-sm font-medium">
            Четыре тонких бэкенда, один OpenAPI-контракт и одни данные. Переключайте реализацию — ответы должны совпадать.
          </p>
          <code className="relative mt-6 inline-block rounded-full bg-card-foreground px-4 py-1.5 text-xs text-card">{baseUrl(backend)}</code>
        </div>
        <div className="relative min-h-64 overflow-hidden rounded-[var(--radius-2xl)]">
          <img src={heroImg} alt="Серверная стойка с жёлтыми индикаторами" width={768} height={1024} className="absolute inset-0 h-full w-full object-cover" />
          <div className="absolute inset-x-4 bottom-4 flex items-center gap-3 rounded-full bg-background/80 px-4 py-2 text-sm backdrop-blur">
            <span className={`h-2.5 w-2.5 rounded-full ${health.isSuccess ? "bg-primary" : "bg-destructive"}`} />
            GET /health — {health.isSuccess ? "ok" : health.isLoading ? "…" : "down"}
          </div>
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-3">
        <div className="card-outline p-6">
          <span className="block h-2.5 w-2.5 rounded-full bg-foreground" />
          <div className="mt-6 font-display text-4xl text-primary">{total.toLocaleString("ru")}</div>
          <p className="text-xs text-muted-foreground">записей по текущему фильтру</p>
        </div>
        <div className="card-light p-6">
          <span className="block h-2.5 w-2.5 rounded-full bg-card-foreground" />
          <div className="mt-6 font-display text-4xl text-primary">{categories.length || "—"}</div>
          <p className="text-xs">категорий в /stats</p>
        </div>
        <div className="rounded-[var(--radius-2xl)] bg-primary p-6 text-primary-foreground">
          <span className="block h-2.5 w-2.5 rounded-full bg-primary-foreground" />
          <div className="mt-6 font-display text-4xl">4</div>
          <p className="text-xs">языка: Go, Node, PHP, Python</p>
        </div>
      </section>

      <section className="flex flex-wrap items-center gap-3">
        <input className="field min-w-56 flex-1" placeholder="Поиск по title…" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} />
        <select className="field select-arrow" value={category} onChange={(e) => { setCategory(e.target.value); setOffset(0); }}>
          <option value="">Все категории</option>
          {categories.map((c) => <option key={c}>{c}</option>)}
        </select>
        <button onClick={() => setEditing(null)} className="rounded-full bg-primary px-6 py-2 font-medium text-primary-foreground">+ Создать</button>
        <span className="flex items-center gap-2">
          <button
            onClick={() => {
              setCompareOpen(true);
              setCompareNonce((n) => n + 1);
            }}
            disabled={alive.length < 2}
            className="rounded-full border px-6 py-2 font-medium disabled:opacity-40"
          >
            Сравнить бэкенды
          </button>
          {alive.length < 2 && (
            <span className="text-xs text-muted-foreground">
              недоступно: живых бэкендов меньше двух ({alive.length ? alive.join(", ") : "ни одного"})
            </span>
          )}
        </span>
      </section>

      {compareOpen && alive.length >= 2 && (
        <CompareRun
          runNonce={compareNonce}
          query={{ limit: LIMIT, offset, sort, category: category || undefined, search: search || undefined }}
        />
      )}

      <section className="card-outline overflow-hidden">
        {list.isError ? (
          <div className="space-y-4 p-10 text-center">
            <p className="font-display text-xl">Ошибка</p>
            <p className="text-sm text-muted-foreground">{(list.error as Error).message}</p>
            <button onClick={() => list.refetch()} className="rounded-full bg-primary px-6 py-2 text-primary-foreground">Повторить</button>
          </div>
        ) : list.isLoading ? (
          <p className="p-10 text-center text-muted-foreground">Загрузка…</p>
        ) : !list.data?.items.length ? (
          <p className="p-10 text-center text-muted-foreground">Ничего не найдено</p>
        ) : (
          <div className="nice-scroll overflow-x-auto">
            <table className={`w-full text-sm ${list.isFetching ? "opacity-60" : ""}`}>
              <thead className="text-left text-muted-foreground">
                <tr className="border-b">
                  <th className="p-4">id</th>
                  <th className="p-4">title</th>
                  <th className="cursor-pointer p-4 hover:text-primary" onClick={() => toggleSort("price")}>price{arrow("price")}</th>
                  <th className="p-4">category</th>
                  <th className="cursor-pointer p-4 hover:text-primary" onClick={() => toggleSort("created_at")}>created_at{arrow("created_at")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((it) => (
                  <tr key={it.id} className="border-b last:border-0">
                    <td className="p-4 font-display text-primary">{it.id}</td>
                    <td className="p-4">{it.title}</td>
                    <td className="p-4 tabular-nums">{it.price}</td>
                    <td className="p-4 text-muted-foreground">{it.category}</td>
                    <td className="p-4 text-muted-foreground">{new Date(it.created_at).toLocaleString("ru")}</td>
                    <td className="whitespace-nowrap p-4 text-right">
                      <button onClick={() => setEditing(it)} className="px-2 hover:text-primary">изм.</button>
                      <button onClick={() => confirm(`Удалить #${it.id}?`) && del.mutate(it.id)} className="px-2 hover:text-destructive">удал.</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">
          {total ? `${offset + 1}–${Math.min(offset + LIMIT, total)} из ${total}` : ""}
        </span>
        <div className="flex gap-2">
          <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - LIMIT))} className="rounded-full border px-5 py-2 disabled:opacity-30">←</button>
          <button disabled={offset + LIMIT >= total} onClick={() => setOffset(offset + LIMIT)} className="rounded-full border px-5 py-2 disabled:opacity-30">→</button>
        </div>
      </section>

      {editing !== undefined && (
        <ItemDialog item={editing} categories={categories} onClose={() => setEditing(undefined)} onSubmit={(d) => save.mutateAsync(d)} />
      )}
    </div>
  );
}
