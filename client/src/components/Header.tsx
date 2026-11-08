import { Link } from "@tanstack/react-router";
import { BACKENDS, type BackendId } from "@/lib/api";
import { useBackend } from "@/lib/backend";

export function Header() {
  const { backend, setBackend } = useBackend();
  return (
    <header className="mx-auto mt-3 flex max-w-6xl items-center gap-6 rounded-full bg-primary px-6 py-3 text-primary-foreground">
      <Link to="/" className="font-display text-lg font-bold tracking-tight">
        polyglot<span className="opacity-60">/bench</span>
      </Link>
      <nav className="flex gap-5 text-sm font-medium">
        <Link to="/" activeOptions={{ exact: true }} activeProps={{ className: "underline underline-offset-4" }}>
          Записи
        </Link>
        <Link to="/benchmarks" activeProps={{ className: "underline underline-offset-4" }}>
          Бенчмарки
        </Link>
      </nav>
      <label className="ml-auto flex items-center gap-2 text-sm font-medium">
        <span className="hidden sm:inline">бэкенд</span>
        <select
          value={backend}
          onChange={(e) => setBackend(e.target.value as BackendId)}
          className="select-arrow rounded-full bg-background py-1.5 pl-4 text-foreground outline-none"
        >
          {BACKENDS.map((b) => (
            <option key={b.id} value={b.id}>
              {b.label}
            </option>
          ))}
        </select>
      </label>
    </header>
  );
}
