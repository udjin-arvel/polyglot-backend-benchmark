import { mockRequest } from "./mock";

export type BackendId = "go" | "node" | "php" | "python" | "demo";

export const BACKENDS: { id: BackendId; label: string; port?: number }[] = [
  { id: "go", label: "Go", port: 8081 },
  { id: "node", label: "Node", port: 8082 },
  { id: "php", label: "PHP", port: 8083 },
  { id: "python", label: "Python", port: 8084 },
  { id: "demo", label: "Демо" },
];

export type Item = {
  id: number;
  title: string;
  price: string;
  category: string;
  created_at: string;
};
export type ItemInput = { title: string; price: string; category: string };
export type ItemsPage = { items: Item[]; total: number; limit: number; offset: number };
export type Stat = { category: string; count: number; avg_price: string };
export type SortKey = "created_at" | "-created_at" | "price" | "-price";
export type ItemsQuery = {
  limit: number;
  offset: number;
  category?: string | undefined;
  search?: string | undefined;
  sort: SortKey;
};

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

const ENV: Record<string, string | undefined> = {
  go: import.meta.env['VITE_API_BASE_GO'],
  node: import.meta.env['VITE_API_BASE_NODE'],
  php: import.meta.env['VITE_API_BASE_PHP'],
  python: import.meta.env['VITE_API_BASE_PYTHON'],
};

export function baseUrl(b: BackendId): string {
  if (b === "demo") return "in-memory";
  return (ENV[b] ?? `/api/${b}`).replace(/\/$/, "");
}

async function request<T>(b: BackendId, method: string, path: string, body?: unknown): Promise<T> {
  if (b === "demo") return mockRequest<T>(method, path, body);
  let res: Response;
  try {
    res = await fetch(baseUrl(b) + path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : null,
    });
  } catch {
    throw new ApiError(0, "network_error", `Бэкенд ${b} недоступен`);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new ApiError(res.status, "bad_response", "Ответ не является JSON");
  }
  if (!res.ok) {
    throw new ApiError(
      res.status,
      data?.error?.code ?? "internal_error",
      data?.error?.message ?? `HTTP ${res.status}`,
    );
  }
  return data as T;
}

export function listPath(q: ItemsQuery): string {
  const p = new URLSearchParams({ limit: String(q.limit), offset: String(q.offset), sort: q.sort });
  if (q.category) p.set("category", q.category);
  if (q.search) p.set("search", q.search);
  return `/items?${p}`;
}

export const api = {
  health: (b: BackendId) => request<{ status: string }>(b, "GET", "/health"),
  list: (b: BackendId, q: ItemsQuery) => request<ItemsPage>(b, "GET", listPath(q)),
  create: (b: BackendId, d: ItemInput) => request<Item>(b, "POST", "/items", d),
  update: (b: BackendId, id: number, d: ItemInput) => request<Item>(b, "PUT", `/items/${id}`, d),
  remove: (b: BackendId, id: number) => request<void>(b, "DELETE", `/items/${id}`),
  stats: (b: BackendId) => request<{ stats: Stat[] }>(b, "GET", "/stats"),
};
