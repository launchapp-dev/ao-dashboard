import { Handle, Position } from "@xyflow/react";
import { cn } from "@/lib/utils";

interface LogFlowStat {
  label: string;
  value: string;
}

export interface LogFlowNodeData extends Record<string, unknown> {
  kind: "lane" | "event";
  title: string;
  subtitle?: string | null;
  meta?: string | null;
  message?: string | null;
  count?: number;
  badges?: string[];
  stats?: LogFlowStat[];
  selected?: boolean;
  current?: boolean;
  tone?: "default" | "tool" | "warn" | "error" | "output" | "thinking";
}

function getToneClasses(tone: LogFlowNodeData["tone"]) {
  switch (tone) {
    case "tool":
      return "border-chart-4/40 bg-chart-4/8";
    case "warn":
      return "border-chart-4/40 bg-chart-4/8";
    case "error":
      return "border-chart-5/40 bg-chart-5/8";
    case "output":
      return "border-chart-1/40 bg-chart-1/8";
    case "thinking":
      return "border-primary/40 bg-primary/8";
    default:
      return "border-border bg-card/90";
  }
}

export function LogFlowNode({ data }: { data: LogFlowNodeData }) {
  const nodeData = data;

  if (nodeData.kind === "lane") {
    return (
      <div className="min-w-[270px] rounded-2xl border border-primary/25 bg-background/95 px-4 py-3 shadow-[0_14px_40px_rgba(0,0,0,0.22)]">
        <Handle type="source" position={Position.Bottom} className="!h-2 !w-2 !border-0 !bg-primary" />
        <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground/70">Lane</div>
        <div className="mt-1 text-sm font-semibold text-foreground">{nodeData.title}</div>
        {nodeData.subtitle && <div className="mt-1 text-[11px] text-muted-foreground">{nodeData.subtitle}</div>}
        <div className="mt-2 flex items-center gap-2 text-[10px] text-muted-foreground/70">
          <span>{nodeData.count ?? 0} events</span>
          {nodeData.meta && <span>{nodeData.meta}</span>}
        </div>
        {nodeData.stats && nodeData.stats.length > 0 && (
          <div className="mt-3 grid grid-cols-2 gap-2">
            {nodeData.stats.map((stat) => (
              <div key={stat.label} className="rounded-xl border border-border/60 bg-card/70 px-2 py-1.5">
                <div className="text-[9px] uppercase tracking-wide text-muted-foreground/60">{stat.label}</div>
                <div className="mt-1 text-[11px] font-semibold text-foreground">{stat.value}</div>
              </div>
            ))}
          </div>
        )}
        {nodeData.badges && nodeData.badges.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {nodeData.badges.map((badge) => (
              <span key={badge} className="rounded-full bg-secondary px-2 py-0.5 text-[9px] text-muted-foreground">
                {badge}
              </span>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={cn(
      "min-w-[220px] max-w-[220px] rounded-xl border px-3 py-2 shadow-[0_8px_18px_rgba(0,0,0,0.16)] transition-shadow",
      getToneClasses(nodeData.tone),
      nodeData.selected && "ring-2 ring-primary/45 shadow-[0_12px_24px_rgba(0,0,0,0.22)]",
      nodeData.current && "ring-2 ring-chart-1/55 shadow-[0_14px_28px_rgba(93,154,128,0.2)]",
    )}>
      <Handle type="target" position={Position.Top} className="!h-2 !w-2 !border-0 !bg-border" />
      <Handle type="source" position={Position.Bottom} className="!h-2 !w-2 !border-0 !bg-primary" />
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">{nodeData.meta}</div>
          <div className="mt-1 text-[11px] font-semibold leading-4 text-foreground">{nodeData.title}</div>
          {nodeData.subtitle && <div className="mt-1 text-[10px] text-muted-foreground">{nodeData.subtitle}</div>}
          {nodeData.badges && nodeData.badges.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {nodeData.badges.map((badge) => (
                <span key={badge} className="rounded-full bg-background/70 px-1.5 py-0.5 text-[9px] text-muted-foreground">
                  {badge}
                </span>
              ))}
            </div>
          )}
          {nodeData.message && (
            <div className="mt-2 line-clamp-3 whitespace-pre-wrap break-words text-[10px] leading-4 text-foreground/88">
              {nodeData.message}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
