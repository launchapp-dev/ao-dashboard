import { Handle, Position } from "@xyflow/react";
import { cn } from "@/lib/utils";

interface Props {
  data: {
    label: string;
    count: number;
    color: string;
    icon: string;
    expanded: boolean;
    onClick: () => void;
  };
}

export function GroupNode({ data }: Props) {
  return (
    <div
      onClick={data.onClick}
      className={cn(
        "rounded-lg px-4 py-2.5 min-w-[130px] font-sans border cursor-pointer transition-colors",
        data.expanded ? "bg-card" : "bg-secondary/50"
      )}
      style={{ borderColor: data.expanded ? "#465063" : "#374151" }}
    >
      <Handle type="target" position={Position.Left} style={{ background: data.color }} />

      <div className="flex items-center gap-2">
        <span className="text-sm">{data.icon}</span>
        <span className="font-bold text-xs uppercase tracking-wide text-foreground">{data.label}</span>
        <span className="text-[10px] text-muted-foreground/40 font-mono">{data.count}</span>
        <span className="text-[10px] text-muted-foreground/30 ml-1">{data.expanded ? "▾" : "▸"}</span>
      </div>

      <Handle type="source" position={Position.Right} style={{ background: data.color }} />
    </div>
  );
}
