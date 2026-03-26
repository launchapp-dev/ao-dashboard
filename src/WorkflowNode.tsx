import { Handle, Position } from "@xyflow/react";
import { cn } from "@/lib/utils";

interface Props {
  data: {
    workflow: {
      project: string;
      workflowRef: string;
      currentPhase: string | null;
      status: string;
      phaseCount?: number;
      cron?: string;
      isScheduled?: boolean;
      name?: string;
      description?: string;
      phases?: string[];
    };
    onClick?: () => void;
    expanded?: boolean;
    onToggle?: () => void;
  };
}

export function WorkflowNode({ data }: Props) {
  const expanded = data.expanded ?? false;
  const { workflow: wf, onClick } = data;

  const isRunning = wf.status === "running";
  const color = isRunning ? "#6d83a6" : "#465063";

  return (
    <div
      onClick={() => {
        if (onClick && !expanded) onClick();
        data.onToggle?.();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          if (onClick && !expanded) onClick();
          data.onToggle?.();
        }
      }}
      role="button"
      tabIndex={0}
      className={cn(
        "rounded-[18px] font-sans cursor-pointer transition-all",
        expanded ? "min-w-[220px]" : "min-w-[180px]"
      )}
      style={{
        background: isRunning ? "rgba(109, 131, 166, 0.12)" : "linear-gradient(180deg, hsl(220 17% 12%), hsl(220 16% 10%))",
        border: `1.5px solid ${color}`,
        padding: "10px 14px",
        boxShadow: "0 16px 30px rgba(0,0,0,0.16)",
      }}
    >
      <Handle type="target" position={Position.Left} style={{ background: color }} />

      <div className="mb-1 flex items-center gap-1.5">
        {isRunning && <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />}
        {wf.isScheduled && !isRunning && <span className="text-[10px] text-muted-foreground">⏱</span>}
        <span className="font-semibold text-[13px] text-foreground">{wf.workflowRef}</span>
        {wf.phaseCount && <span className="text-[10px] text-muted-foreground">{wf.phaseCount} phases</span>}
      </div>

      {wf.currentPhase && (
        <div className="text-[11px] text-muted-foreground">Current phase: <span className="text-foreground">{wf.currentPhase}</span></div>
      )}

      {wf.cron && <div className="font-mono text-[10px] text-muted-foreground">{wf.cron}</div>}

      {expanded && (
        <div className="mt-2 border-t border-border/30 pt-2 text-[10px]">
          {wf.name && <div className="mb-0.5 text-muted-foreground">{wf.name}</div>}
          {wf.description && <div className="mb-1 text-muted-foreground">{wf.description}</div>}
          <div className="text-muted-foreground">
            <span>Status:</span> <span className={isRunning ? "text-primary" : "text-muted-foreground"}>{wf.status}</span>
          </div>
          {wf.phases && wf.phases.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {wf.phases.map((phase, i) => (
                <span key={i} className="rounded-full bg-secondary px-2 py-0.5 text-[9px] text-muted-foreground">{i + 1}. {phase}</span>
              ))}
            </div>
          )}
        </div>
      )}

      <Handle type="source" position={Position.Right} style={{ background: color }} />
    </div>
  );
}
