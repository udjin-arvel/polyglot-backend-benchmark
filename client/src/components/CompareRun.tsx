import { useCallback, useEffect, useRef, useState } from "react";
import { api, listPath, BACKENDS, type BackendId, type Item, type ItemsQuery, type SortKey } from "@/lib/api";

export const REAL_BACKENDS = BACKENDS.filter((b) => b.id !== "demo").map((b) => b.id);

const RUNS = 3;
const FIELDS = ["title", "price", "category", "created_at"] as const;

type Run = {
  id: BackendId;
  label: string;
  times: number[];
  ok: boolean;
  error: string | undefined;
  items?: Item[];
};

type CellDiffs = Partial<Record<(typeof FIELDS)[number], string[]>>;
type RowDiff = { cells: CellDiffs; missingIn: string[] };

const SORTS = new Set<SortKey>(["created_at", "-created_at", "price", "-price"]);
const MAX_LIMIT = 10000;

function intParam(raw: string | null, fallback: number): number | null {
  if (raw === null || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) return null;
  return Number(raw);
}

export function parseListRequest(raw: string): ItemsQuery | string {
  let url: URL;
  try {
    url = new URL(raw.trim().replace(/^GET\s+/i, ""), "http://local");
  } catch {
    return "Не удалось разобрать строку запроса";
  }
  if (url.pathname !== "/items") return "Путь должен быть /items";
  const limit = intParam(url.searchParams.get("limit"), 100);
  const offset = intParam(url.searchParams.get("offset"), 0);
  const sort = (url.searchParams.get("sort") || "-created_at") as SortKey;
  if (limit === null || limit < 1 || limit > MAX_LIMIT) return `limit — целое от 1 до ${MAX_LIMIT}`;
  if (offset === null || offset < 0) return "offset — целое от 0";
  if (!SORTS.has(sort)) return "sort: created_at, -created_at, price или -price";
  return {
    limit,
    offset,
    sort,
    category: url.searchParams.get("category") || undefined,
    search: url.searchParams.get("search") || undefined,
  };
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
};

const sameData = (a: Item[], b: Item[]) =>
  a.length === b.length && a.every((x, i) => JSON.stringify(x) === JSON.stringify(b[i]));

export function CompareRun({ query, runNonce }: { query: ItemsQuery; runNonce: number }) {
  const [running, setRunning] = useState(false);
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [line, setLine] = useState(() => `GET ${listPath({ ...query, limit: 100 })}`);
  const [lineError, setLineError] = useState<string | null>(null);
  const lineRef = useRef(line);
  lineRef.current = line;

  const run = useCallback(async () => {
    const parsed = parseListRequest(lineRef.current);
    if (typeof parsed === "string") {
      setLineError(parsed);
      return;
    }
    setLineError(null);
    setRunning(true);
    setRuns(null);
    const q = parsed;

    const health = await Promise.allSettled(REAL_BACKENDS.map((b) => api.health(b)));
    const alive = REAL_BACKENDS.filter((_, i) => health[i]!.status === "fulfilled");
    const acc = new Map<BackendId, Run>(
      REAL_BACKENDS.map((b) => [
        b,
        {
          id: b,
          label: BACKENDS.find((x) => x.id === b)!.label,
          times: [],
          ok: false,
          error: alive.includes(b) ? undefined : "недоступен",
        },
      ]),
    );

    for (let i = 0; i < RUNS; i++) {
      await Promise.all(
        alive.map(async (b) => {
          const r = acc.get(b)!;
          const t0 = performance.now();
          try {
            const page = await api.list(b, q);
            r.times.push(Math.round(performance.now() - t0));
            r.ok = true;
            r.items = page.items;
            r.error = undefined;
          } catch (e: unknown) {
            if (!r.ok) r.error = e instanceof Error ? e.message : "ошибка";
          }
        }),
      );
    }
    setRuns([...acc.values()]);
    setRunning(false);
  }, []);

  useEffect(() => {
    void run();
  }, [runNonce, run]);

  const successful = runs?.filter((r) => r.ok && r.items) ?? [];
  const ref = successful.length
    ? successful.reduce((a, b) => (median(a.times) <= median(b.times) ? a : b))
    : null;
  const others = successful.filter((r) => r.id !== ref?.id);

  const diffs = new Map<number, RowDiff>();
  if (ref?.items) {
    const otherMaps = others.map((r) => ({ label: r.label, map: new Map(r.items!.map((i) => [i.id, i])) }));
    for (const row of ref.items) {
      const cells: CellDiffs = {};
      const missingIn: string[] = [];
      for (const { label, map } of otherMaps) {
        const o = map.get(row.id);
        if (!o) {
          missingIn.push(label);
          continue;
        }
        for (const f of FIELDS) {
          if (o[f] !== row[f]) (cells[f] ??= []).push(`${o[f]} (${label})`);
        }
      }
      if (missingIn.length || Object.keys(cells).length) diffs.set(row.id, { cells, missingIn });
    }
  }

  const refIds = ref?.items ? new Set(ref.items.map((i) => i.id)) : null;
  const extraByBackend =
    refIds && ref
      ? others
          .map((r) => {
            const extra = r.items!.filter((i) => !refIds.has(i.id));
            return extra.length ? { label: r.label, extra } : null;
          })
          .filter((x): x is { label: string; extra: Item[] } => x !== null)
      : [];

  const cell = (row: Item, f: (typeof FIELDS)[number], d?: RowDiff) => (
    <td className={`p-3 ${d?.cells[f] ? "bg-destructive/15" : ""}`}>
      {f === "created_at" ? new Date(row[f]).toLocaleString("ru") : row[f]}
      {d?.cells[f]?.map((v) => (
        <div key={v} className="text-xs text-destructive">
          ≠ {v}
        </div>
      ))}
    </td>
  );

  const responseLabel = (r: Run) => {
    if (!r.ok) return r.error ?? "недоступен";
    const n = r.times.length;
    if (n < RUNS) return `200 (${n} из ${RUNS})`;
    return "200";
  };

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <input
          value={line}
          onChange={(e) => setLine(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void run();
          }}
          spellCheck={false}
          aria-label="Запрос сравнения"
          className="min-w-72 flex-1 rounded-full bg-card-foreground px-4 py-2 font-mono text-xs text-card outline-none"
        />
        <button
          onClick={() => void run()}
          disabled={running}
          className="rounded-full bg-primary px-6 py-2 font-medium text-primary-foreground disabled:opacity-50"
        >
          {running ? "Гоняю запросы…" : "Повторить сравнение"}
        </button>
      </div>
      {lineError && <p className="text-sm text-destructive">{lineError}</p>}

      {running && !runs && <p className="text-sm text-muted-foreground">Гоняю запросы…</p>}

      {runs && ref && (
        <>
          <div className="card-outline overflow-hidden">
            <div className="nice-scroll overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead className="text-left text-muted-foreground">
                  <tr className="border-b">
                    <th className="p-4" />
                    {runs.map((r) => (
                      <th key={r.id} className={`p-4 ${r.id === ref.id ? "text-primary" : ""}`}>
                        {r.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b">
                    <td className="p-4 text-muted-foreground">медиана</td>
                    {runs.map((r) => (
                      <td key={r.id} className={`p-4 font-display text-xl ${r.id === ref.id ? "text-primary" : ""}`}>
                        {r.times.length ? `${median(r.times)} мс` : "—"}
                      </td>
                    ))}
                  </tr>
                  <tr className="border-b">
                    <td className="p-4 text-muted-foreground">min / max</td>
                    {runs.map((r) => (
                      <td key={r.id} className="p-4 tabular-nums">
                        {r.times.length ? `${Math.min(...r.times)} / ${Math.max(...r.times)}` : "—"}
                      </td>
                    ))}
                  </tr>
                  <tr className="border-b">
                    <td className="p-4 text-muted-foreground">ответ</td>
                    {runs.map((r) => (
                      <td key={r.id} className={`p-4 ${r.ok ? "" : "text-destructive"}`}>
                        {responseLabel(r)}
                      </td>
                    ))}
                  </tr>
                  <tr>
                    <td className="p-4 text-muted-foreground">данные</td>
                    {runs.map((r) => (
                      <td key={r.id} className="p-4">
                        {r.id === ref.id
                          ? "эталон"
                          : r.ok && r.items
                            ? sameData(ref.items!, r.items)
                              ? "совпали"
                              : <span className="text-destructive">отличается</span>
                            : "—"}
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <p className="text-sm text-muted-foreground">
            Три прогона на каждый живой бэкенд, в таблице ответ эталона ({ref.label}). Время относится ко всему ответу, а
            не к строке. Лимит в строке запроса — от 1 до {MAX_LIMIT}.
          </p>

          <div className="card-outline overflow-hidden">
            <div className="nice-scroll max-h-[32rem] overflow-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-card text-left text-muted-foreground">
                  <tr className="border-b">
                    <th className="p-3">id</th>
                    <th className="p-3">title</th>
                    <th className="p-3">price</th>
                    <th className="p-3">category</th>
                    <th className="p-3">created_at</th>
                  </tr>
                </thead>
                <tbody>
                  {ref.items!.map((row) => {
                    const d = diffs.get(row.id);
                    return (
                      <tr key={row.id} className={`border-b last:border-0 ${d ? "bg-destructive/10" : ""}`}>
                        <td className="p-3 font-display text-primary">
                          {row.id}
                          {d?.missingIn.map((l) => (
                            <div key={l} className="text-xs font-sans text-destructive">
                              нет в {l}
                            </div>
                          ))}
                        </td>
                        {cell(row, "title", d)}
                        {cell(row, "price", d)}
                        {cell(row, "category", d)}
                        {cell(row, "created_at", d)}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {extraByBackend.length > 0 && (
            <p className="text-sm text-destructive">
              {extraByBackend.map(({ label, extra }) => {
                const ids = extra.map((i) => i.id);
                const show = ids.slice(0, 8).join(", ");
                const more = ids.length > 8 ? ` и ещё ${ids.length - 8}` : "";
                return (
                  <span key={label} className="block">
                    У {label}: {ids.length} id нет в эталоне ({show}
                    {more})
                  </span>
                );
              })}
            </p>
          )}

          <p className="text-xs text-muted-foreground">
            Это смоук в браузере, не официальный бенч: в замер входят сеть, nginx и браузер. Нагрузку, RPS и p99 смотрите
            на странице «Бенчмарки».
          </p>
        </>
      )}

      {runs && !ref && <p className="text-sm text-destructive">Ни один бэкенд не ответил успешно.</p>}
    </section>
  );
}
