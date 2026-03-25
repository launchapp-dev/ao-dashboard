import { Handle, Position } from "@xyflow/react";

interface Props {
  data: {
    id: string;
    cron: string;
    humanCron: string;
    enabled: boolean;
  };
}

export function ScheduleNode({ data }: Props) {
  return (
    <div className="bg-card border border-chart-4/40 rounded-lg px-3 py-2 min-w-[150px] font-sans">
      <Handle type="target" position={Position.Left} style={{ background: "#eab308" }} />

      <div className="flex items-center gap-1.5 mb-1">
        <span className="text-chart-4 text-xs">⏱</span>
        <span className="font-semibold text-xs text-chart-4">{data.id}</span>
        {!data.enabled && <span className="text-[8px] text-chart-5 bg-chart-5/10 px-1 rounded">off</span>}
      </div>
      <div className="text-[10px] text-muted-foreground">{data.humanCron}</div>
      <div className="text-[9px] text-muted-foreground/40 font-mono">{data.cron}</div>

      <Handle type="source" position={Position.Right} style={{ background: "#eab308" }} />
    </div>
  );
}
