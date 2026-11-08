import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { BACKENDS, type BackendId } from "./api";

const Ctx = createContext<{ backend: BackendId; setBackend: (b: BackendId) => void }>({
  backend: "demo",
  setBackend: () => {},
});

export function BackendProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [backend, setState] = useState<BackendId>("demo");
  useEffect(() => {
    const s = localStorage.getItem("selectedBackend") as BackendId | null;
    if (s && BACKENDS.some((b) => b.id === s)) setState(s);
  }, []);
  const setBackend = (b: BackendId) => {
    localStorage.setItem("selectedBackend", b);
    setState(b);
    qc.invalidateQueries();
  };
  return <Ctx.Provider value={{ backend, setBackend }}>{children}</Ctx.Provider>;
}

export const useBackend = () => useContext(Ctx);
