import { useRef, useEffect, useState } from "react";
import type { StreamEvent } from "./types";

interface Props {
  events: StreamEvent[];
}

export function EventStream({ events }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState("");
  const [levelFilter, setLevelFilter] = useState<string>("all");

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events]);

  const filtered = events.filter((e) => {
    if (levelFilter !== "all" && e.level !== levelFilter) return false;
    if (filter && !e.project.includes(filter) && !e.msg.includes(filter) && !e.cat.includes(filter))
      return false;
    return true;
  });

  return (
    <div className="event-stream">
      <div className="stream-filters">
        <input
          type="text"
          placeholder="Filter by project, message, or category..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="filter-input"
        />
        <select
          value={levelFilter}
          onChange={(e) => setLevelFilter(e.target.value)}
          className="filter-select"
        >
          <option value="all">All levels</option>
          <option value="error">Errors</option>
          <option value="warn">Warnings</option>
          <option value="info">Info</option>
        </select>
      </div>
      <div className="stream-list">
        {filtered.map((e, i) => (
          <div key={i} className={`stream-event level-${e.level}`}>
            <span className="event-time">{e.ts.slice(11, 19)}</span>
            <span className="event-project">{e.project}</span>
            <span className="event-cat">{e.cat}</span>
            <span className="event-msg">{e.msg}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
