import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { StreamEvent } from "./types";

interface Props {
  events: StreamEvent[];
}

export function EventStream({ events }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState("");
  const [levelFilter, setLevelFilter] = useState<string>("all");
  const [autoScroll, setAutoScroll] = useState(true);

  useEffect(() => {
    if (autoScroll) {
      bottomRef.current?.scrollIntoView({ behavior: "auto" });
    }
  }, [autoScroll, events.length]);

  const filtered = useMemo(() => {
    const query = filter.trim().toLowerCase();
    return events.filter((event) => {
      if (levelFilter !== "all" && event.level !== levelFilter) return false;
      if (!query) return true;
      const haystack = `${event.project} ${event.msg} ${event.cat}`.toLowerCase();
      return haystack.includes(query);
    });
  }, [events, filter, levelFilter]);

  const handleScroll = () => {
    if (!logRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = logRef.current;
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 40);
  };

  const getEventKey = (event: StreamEvent, index: number) =>
    `${event.project_root ?? event.project}:${event.ts}:${event.cat}:${event.task_id ?? ""}:${event.phase_id ?? ""}:${index}`;

  return (
    <div className="flex flex-col h-full">
      <div className="flex gap-2 px-4 py-2 bg-card border-b border-border">
        <input
          type="text"
          placeholder="Filter by project, message, or category..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="flex-1 px-3 py-1.5 bg-secondary border border-border rounded-md text-foreground text-sm outline-none focus:border-primary"
        />
        <select
          value={levelFilter}
          onChange={(e) => setLevelFilter(e.target.value)}
          className="px-3 py-1.5 bg-secondary border border-border rounded-md text-foreground text-sm"
        >
          <option value="all">All levels</option>
          <option value="error">Errors</option>
          <option value="warn">Warnings</option>
          <option value="info">Info</option>
        </select>
      </div>
      <div ref={logRef} onScroll={handleScroll} className="flex-1 overflow-y-auto font-mono text-xs">
        {filtered.map((e, i) => (
          <div
            key={getEventKey(e, i)}
            className={cn(
              "flex gap-2 px-4 py-0.5 border-b border-border/30 hover:bg-card",
              e.level === "error" && "text-chart-5",
              e.level === "warn" && "text-chart-4",
              e.level === "info" && "text-muted-foreground"
            )}
          >
            <span className="text-muted-foreground/50 min-w-[55px]">{e.ts.slice(11, 19)}</span>
            <span className="text-primary min-w-[130px] font-medium">{e.project}</span>
            <span className="text-muted-foreground min-w-[110px]">{e.cat}</span>
            <span className="flex-1 whitespace-nowrap overflow-hidden text-ellipsis">{e.msg}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
