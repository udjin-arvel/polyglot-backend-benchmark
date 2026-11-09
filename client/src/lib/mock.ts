// In-memory implementation of the OpenAPI contract, used by the "Демо" backend option.
import type { Item } from "./api";

const CATEGORIES = [
  "automotive", "baby", "beauty", "books", "clothing", "electronics", "food", "furniture",
  "garden", "health", "jewelry", "music", "office", "outdoor", "pets", "shoes", "software",
  "sports", "tools", "toys",
];
const WORDS = ["Smart", "Classic", "Pro", "Mini", "Eco", "Ultra", "Vintage", "Compact", "Deluxe", "Basic"];
const NOUNS = ["lamp", "chair", "notebook", "kettle", "speaker", "jacket", "bottle", "drill", "puzzle", "bag"];

let seed = 42;
const rnd = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;

let nextId = 1;
const items: Item[] = Array.from({ length: 500 }, () => {
  const id = nextId++;
  return {
    id,
    title: `${WORDS[Math.floor(rnd() * 10)]} ${NOUNS[Math.floor(rnd() * 10)]} #${id}`,
    price: (rnd() * 500).toFixed(2),
    category: CATEGORIES[Math.floor(rnd() * 20)]!,
    created_at: new Date(Date.UTC(2026, 10, 1) - Math.floor(rnd() * 365 * 864e5)).toISOString(),
  };
});

const err = (status: number, code: string, message: string) =>
  Object.assign(new Error(message), { status, code, isApi: true });

function validate(b: any) {
  const t: string = typeof b?.title === "string" ? b.title : "";
  if (t.length < 1 || t.length > 255) throw err(422, "validation_error", "title: 1..255 символов");
  if (typeof b?.price !== "string" || !/^\d+(\.\d{1,2})?$/.test(b.price))
    throw err(422, "validation_error", "price: неотрицательное число строкой");
  if (!CATEGORIES.includes(b?.category)) throw err(422, "validation_error", "category не существует");
  return { title: t, price: Number(b.price).toFixed(2), category: b.category as string };
}

export async function mockRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  const { ApiError } = await import("./api");
  await new Promise((r) => setTimeout(r, 120));
  try {
    return handle(method, path, body) as T;
  } catch (e: any) {
    if (e.isApi) throw new ApiError(e.status, e.code, e.message);
    throw e;
  }
}

function handle(method: string, path: string, body: any): unknown {
  const url = new URL(path, "http://x");
  const m = url.pathname.match(/^\/items\/(.+)$/);
  if (url.pathname === "/health") return { status: "ok" };
  if (url.pathname === "/stats") {
    return {
      stats: CATEGORIES.map((c) => {
        const xs = items.filter((i) => i.category === c);
        const avg = xs.length ? xs.reduce((s, i) => s + Number(i.price), 0) / xs.length : 0;
        return { category: c, count: xs.length, avg_price: avg.toFixed(2) };
      }),
    };
  }
  if (url.pathname === "/items" && method === "GET") {
    const q = url.searchParams;
    const limit = Number(q.get("limit") ?? 20);
    const offset = Number(q.get("offset") ?? 0);
    if (!(limit >= 1 && limit <= 10000) || !(offset >= 0)) throw err(400, "bad_request", "limit/offset");
    let xs = items;
    const cat = q.get("category");
    const s = q.get("search")?.toLowerCase();
    if (cat) xs = xs.filter((i) => i.category === cat);
    if (s) xs = xs.filter((i) => i.title.toLowerCase().includes(s));
    const sort = q.get("sort") ?? "-created_at";
    const key = sort.replace("-", "") as "price" | "created_at";
    const dir = sort.startsWith("-") ? -1 : 1;
    xs = [...xs].sort((a, b) =>
      key === "price" ? (Number(a.price) - Number(b.price)) * dir : a.created_at.localeCompare(b.created_at) * dir,
    );
    return { items: xs.slice(offset, offset + limit), total: xs.length, limit, offset };
  }
  if (url.pathname === "/items" && method === "POST") {
    const it = { id: nextId++, ...validate(body), created_at: new Date().toISOString() };
    items.push(it);
    return it;
  }
  if (m) {
    const id = Number(m[1]);
    if (!Number.isInteger(id)) throw err(400, "bad_request", "id должен быть числом");
    const idx = items.findIndex((i) => i.id === id);
    if (idx < 0) throw err(404, "not_found", `item ${id} не найден`);
    if (method === "GET") return items[idx];
    if (method === "PUT") {
      const cur = items[idx]!;
      const next: Item = { ...cur, ...validate(body) };
      items[idx] = next;
      return next;
    }
    if (method === "DELETE") {
      items.splice(idx, 1);
      return undefined;
    }
  }
  throw err(404, "not_found", "route not found");
}
