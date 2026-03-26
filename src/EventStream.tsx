import { useEffect, useMemo, useRef, useState } from "react";
import type { StreamEvent } from "./types";
import { LogEventList, type LogGroupMode } from "./LogEventList";

interface Props {
  events: StreamEvent[];
}

export function EventStream({ events }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState("");
  const [levelFilter, setLevelFilter] = useState<string>("all");
  const [groupMode, setGroupMode] = useState<LogGroupMode>("conversation");
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
      const haystack = `${event.project} ${event.msg} ${event.content ?? ""} ${event.error ?? ""} ${event.cat} ${event.tool ?? ""} ${event.workflow_ref ?? ""} ${event.task_id ?? ""} ${event.run_id ?? ""}`.toLowerCase();
      return haystack.includes(query);
    });
  }, [events, filter, levelFilter]);

  const handleScroll = () => {
    if (!logRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = logRef.current;
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 40);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-col gap-2 border-b border-border bg-card/55 px-4 py-3 sm:flex-row">
        <label className="flex-1">
          <span className="sr-only">Filter events</span>
          <input
            type="text"
            placeholder="Filter by project, message, or category..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="Filter events"
            className="flex w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
          />
        </label>
        <label>
          <span className="sr-only">Filter by log level</span>
          <select
            value={levelFilter}
            onChange={(e) => setLevelFilter(e.target.value)}
            aria-label="Filter by log level"
            className="rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground"
          >
            <option value="all">All levels</option>
            <option value="error">Errors</option>
            <option value="warn">Warnings</option>
            <option value="info">Info</option>
          </select>
        </label>
        <label>
          <span className="sr-only">Group events by</span>
          <select
            value={groupMode}
            onChange={(e) => setGroupMode(e.target.value as LogGroupMode)}
            aria-label="Group events by"
            className="rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground"
          >
            <option value="conversation">Group by Conversation</option>
            <option value="workflow">Group by Workflow</option>
            <option value="flat">Flat</option>
          </select>
        </label>
      </div>
      <div ref={logRef} onScroll={handleScroll} className="flex-1 overflow-y-auto font-mono text-xs">
        {filtered.length === 0 ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
            No events match the current filter.
          </div>
        ) : (
          <LogEventList
            events={filtered}
            groupMode={groupMode}
            showProject
          />
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
