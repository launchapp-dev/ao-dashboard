import { useState } from "react";
import { Handle, Position } from "@xyflow/react";
import { cn } from "@/lib/utils";

interface Props {
  data: {
    id: string;
    cron: string;
    humanCron: string;
    enabled: boolean;
    workflow_ref?: string;
  };
}

export function ScheduleNode({ data }: Props) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      onClick={() => setExpanded(!expanded)}
      className={cn(
        "bg-card border border-chart-4/40 rounded-lg px-3 py-2 font-sans cursor-pointer transition-all",
        expanded ? "min-w-[200px]" : "min-w-[150px]"
      )}
    >
      <Handle type="target" position={Position.Left} style={{ background: "#eab308" }} />

      <div className="flex items-center gap-1.5 mb-1">
        <span className="text-chart-4 text-xs">⏱</span>
        <span className="font-semibold text-xs text-chart-4">{data.id}</span>
        {!data.enabled && <span className="text-[8px] text-chart-5 bg-chart-5/10 px-1 rounded">off</span>}
      </div>
      <div className="text-[10px] text-muted-foreground">{data.humanCron}</div>
      <div className="text-[9px] text-muted-foreground/40 font-mono">{data.cron}</div>

      {expanded && (
        <div className="mt-2 pt-2 border-t border-border/30 text-[9px] space-y-0.5">
          <div><span className="text-muted-foreground/50">Cron: </span><span className="font-mono text-chart-4">{data.cron}</span></div>
          <div><span className="text-muted-foreground/50">Interval: </span><span className="text-foreground">{data.humanCron}</span></div>
          <div><span className="text-muted-foreground/50">Enabled: </span><span className={data.enabled ? "text-chart-1" : "text-chart-5"}>{data.enabled ? "yes" : "no"}</span></div>
          {data.workflow_ref && <div><span className="text-muted-foreground/50">Triggers: </span><span className="text-accent">{data.workflow_ref}</span></div>}
        </div>
      )}

      <Handle type="source" position={Position.Right} style={{ background: "#eab308" }} />
    </div>
  );
}
