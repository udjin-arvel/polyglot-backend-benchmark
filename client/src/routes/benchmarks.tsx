import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

export const Route = createFileRoute("/benchmarks")({
  head: () => ({
    meta: [
      { title: "Benchmarks — Polyglot Backend Benchmark" },
      { name: "description", content: "RPS, латентность p50/p95/p99, память и cold-start для Go, Node, PHP и Python." },
      { property: "og:title", content: "Benchmarks — Polyglot Backend Benchmark" },
      { property: "og:description", content: "Сравнение тонких бэкендов на одном контракте и одних данных." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: BenchPage,
});

type Result = {
  scenario: string;
  backend: string;
  mode: string;
  rps_target: number;
  rps_actual: number;
  latency: { p50: number; p95: number; p99: number };
  rss_mb: number;
  rss_idle_mb?: number;
  cpu_pct: number;
  cold_start_ms?: number;
  image_mb?: number;
  loc?: number;
};

const SCENARIOS: string[] = ["read-heavy", "mixed-crud", "aggregate"];
const MODES = ["fixed-rps", "ramp-up"];
const ORDER = ["go", "node", "php", "python"];

async function loadResults(): Promise<Result[]> {
  const files: string[] = await fetch("/bench/index.json").then((r) => r.json());
  return Promise.all(files.map((f) => fetch(`/bench/${f}`).then((r) => r.json())));
}

const axis = { stroke: "var(--muted-foreground)", fontSize: 12 };
const tip = { contentStyle: { background: "var(--card)", color: "var(--card-foreground)", border: "none", borderRadius: 12 } };

function Chart({ title, data, keys }: { title: string; data: object[]; keys: { k: string; name: string; color: string }[] }) {
  return (
    <div className="card-outline p-6">
      <h3 className="mb-4 font-display text-lg">{title}</h3>
      <ResponsiveContainer width="100%" height={240}>
        <BarChart data={data}>
          <CartesianGrid stroke="var(--border)" vertical={false} />
          <XAxis dataKey="backend" {...axis} />
          <YAxis {...axis} />
          <Tooltip {...tip} cursor={{ fill: "var(--secondary)" }} />
          {keys.length > 1 && <Legend />}
          {keys.map((x) => <Bar key={x.k} dataKey={x.k} name={x.name} fill={x.color} radius={[6, 6, 0, 0]} />)}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function BenchPage() {
  const [scenario, setScenario] = useState("read-heavy");
  const [mode, setMode] = useState("fixed-rps");
  const { data, isLoading, isError, refetch } = useQuery({ queryKey: ["bench"], queryFn: loadResults });

  const rows = (data ?? [])
    .filter((r) => r.scenario === scenario && r.mode === mode)
    .sort((a, b) => ORDER.indexOf(a.backend) - ORDER.indexOf(b.backend))
    .map((r) => ({ ...r, ...r.latency }));

  const Pill = ({ v, cur, set }: { v: string; cur: string; set: (s: string) => void }) => (
    <button onClick={() => set(v)} className={`rounded-full px-4 py-1.5 text-sm ${cur === v ? "bg-primary text-primary-foreground" : "border"}`}>{v}</button>
  );

  return (
    <div className="space-y-10">
      <p className="max-w-4xl font-display text-2xl leading-snug md:text-3xl">
        <span className="text-primary">• сравниваем реализации,</span> а не языки в вакууме — результаты зависят от версий, железа и конфигов.
      </p>

      <div className="flex flex-wrap gap-6">
        <div className="flex flex-wrap gap-2">{SCENARIOS.map((s) => <Pill key={s} v={s} cur={scenario} set={setScenario} />)}</div>
        <div className="flex flex-wrap gap-2">{MODES.map((s) => <Pill key={s} v={s} cur={mode} set={setMode} />)}</div>
      </div>

      {isLoading ? (
        <p className="text-muted-foreground">Загрузка результатов…</p>
      ) : isError ? (
        <button onClick={() => refetch()} className="rounded-full bg-primary px-6 py-2 text-primary-foreground">Не удалось загрузить — повторить</button>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2">
            <Chart title="RPS" data={rows} keys={[{ k: "rps_actual", name: "RPS", color: "var(--chart-1)" }]} />
            <Chart title="Латентность, мс" data={rows} keys={[
              { k: "p50", name: "p50", color: "var(--chart-2)" },
              { k: "p95", name: "p95", color: "var(--chart-1)" },
              { k: "p99", name: "p99", color: "var(--chart-3)" },
            ]} />
            <Chart title="RSS, МБ" data={rows} keys={[
              { k: "rss_idle_mb", name: "idle", color: "var(--chart-4)" },
              { k: "rss_mb", name: "под нагрузкой", color: "var(--chart-1)" },
            ]} />
            <Chart title="Cold-start, мс" data={rows} keys={[{ k: "cold_start_ms", name: "cold-start", color: "var(--chart-2)" }]} />
          </div>

          <div className="card-light nice-scroll overflow-x-auto p-2">
            <table className="w-full text-sm">
              <thead className="text-left opacity-60">
                <tr>{["backend", "RPS цель", "RPS факт", "p50", "p95", "p99", "RSS idle", "RSS load", "CPU %", "cold-start", "образ, МБ", "LOC"].map((h) => <th key={h} className="p-3">{h}</th>)}</tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.backend} className="border-t" style={{ borderColor: "oklch(0.9 0 0)" }}>
                    <td className="p-3 font-display">{r.backend}</td>
                    <td className="p-3">{r.rps_target}</td>
                    <td className="p-3 font-bold">{r.rps_actual}</td>
                    <td className="p-3">{r.p50}</td>
                    <td className="p-3">{r.p95}</td>
                    <td className="p-3">{r.p99}</td>
                    <td className="p-3">{r.rss_idle_mb ?? "—"}</td>
                    <td className="p-3">{r.rss_mb}</td>
                    <td className="p-3">{r.cpu_pct}</td>
                    <td className="p-3">{r.cold_start_ms ?? "—"}</td>
                    <td className="p-3">{r.image_mb ?? "—"}</td>
                    <td className="p-3">{r.loc ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
