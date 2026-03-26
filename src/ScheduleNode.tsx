import { Handle, Position } from "@xyflow/react";
import { cn } from "@/lib/utils";

interface Props {
  data: {
    id: string;
    cron: string;
    humanCron: string;
    enabled: boolean;
    workflow_ref?: string;
    expanded?: boolean;
    onToggle?: () => void;
  };
}

export function ScheduleNode({ data }: Props) {
  const expanded = data.expanded ?? false;

  return (
    <div
      onClick={data.onToggle}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          data.onToggle?.();
        }
      }}
      role="button"
      tabIndex={0}
      className={cn(
        "rounded-[16px] border border-border bg-card px-3 py-3 font-sans cursor-pointer transition-all",
        expanded ? "min-w-[200px]" : "min-w-[150px]"
      )}
    >
      <Handle type="target" position={Position.Left} style={{ background: "#465063" }} />

      <div className="mb-1 flex items-center gap-1.5">
        <span className="text-xs text-muted-foreground">⏱</span>
        <span className="font-semibold text-[12px] text-foreground">{data.id}</span>
        {!data.enabled && <span className="rounded-full bg-chart-5/10 px-2 py-0.5 text-[9px] text-chart-5">off</span>}
      </div>
      <div className="text-[11px] text-muted-foreground">{data.humanCron}</div>
      <div className="font-mono text-[10px] text-muted-foreground">{data.cron}</div>

      {expanded && (
        <div className="mt-2 space-y-0.5 border-t border-border/30 pt-2 text-[10px]">
          <div><span className="text-muted-foreground">Cron: </span><span className="font-mono text-foreground">{data.cron}</span></div>
          <div><span className="text-muted-foreground">Interval: </span><span className="text-foreground">{data.humanCron}</span></div>
          <div><span className="text-muted-foreground/50">Enabled: </span><span className={data.enabled ? "text-foreground" : "text-chart-5"}>{data.enabled ? "yes" : "no"}</span></div>
          {data.workflow_ref && <div><span className="text-muted-foreground">Triggers: </span><span className="text-foreground">{data.workflow_ref}</span></div>}
        </div>
      )}

      <Handle type="source" position={Position.Right} style={{ background: "#465063" }} />
    </div>
  );
}
