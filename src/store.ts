import { load } from "@tauri-apps/plugin-store";
import type { DaemonHealth, StreamEvent, WorkflowInfo, TaskSummary } from "./types";

let store: Awaited<ReturnType<typeof load>> | null = null;

async function getStore() {
  if (!store) {
    store = await load("fleet-cache.json");
  }
  return store;
}

export interface CachedFleetData {
  health: DaemonHealth[];
  workflows: Record<string, WorkflowInfo[]>;
  tasks: Record<string, TaskSummary>;
  events: StreamEvent[];
  updatedAt: number;
}

export async function loadCachedFleet(): Promise<CachedFleetData | null> {
  try {
    const s = await getStore();
    const data = await s.get<CachedFleetData>("fleet");
    return data ?? null;
  } catch {
    return null;
  }
}

export async function saveCachedFleet(data: CachedFleetData): Promise<void> {
  try {
    const s = await getStore();
    await s.set("fleet", data);
  } catch {}
}
