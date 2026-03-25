import { Handle, Position } from "@xyflow/react";
import { cn } from "@/lib/utils";

interface Props {
  data: {
    label: string;
    count: number;
    color: string;
    icon: string;
  };
}

export function GroupNode({ data }: Props) {
  return (
    <div className={cn(
      "rounded-lg px-4 py-2.5 min-w-[130px] font-sans border",
      "bg-card"
    )} style={{ borderColor: `${data.color}40` }}>
      <Handle type="target" position={Position.Left} style={{ background: data.color }} />

      <div className="flex items-center gap-2">
        <span className="text-sm">{data.icon}</span>
        <span className="font-bold text-xs uppercase tracking-wide" style={{ color: data.color }}>{data.label}</span>
        <span className="text-[10px] text-muted-foreground/40 font-mono">{data.count}</span>
      </div>

      <Handle type="source" position={Position.Right} style={{ background: data.color }} />
    </div>
  );
}
