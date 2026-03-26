import { Handle, Position } from "@xyflow/react";
import { cn } from "@/lib/utils";

interface Props {
  data: {
    phase: string;
    index?: string;
    workflowRef: string;
    mode?: string;
    agent?: string;
    command?: string;
    command_args?: string[];
    directive?: string;
    model?: string;
    isActive?: boolean;
    timeout_secs?: number;
    cwd_mode?: string;
    expanded?: boolean;
    onToggle?: () => void;
  };
}

export function PhaseNode({ data }: Props) {
  const expanded = data.expanded ?? false;
  const { phase, index, mode, agent, command, model, isActive, directive } = data;

  const isCommand = mode === "command";
  const color = isActive ? "#6d83a6" : "#465063";

  return (
    <div
      onClick={data.onToggle}
      className={cn(
        "rounded-md font-sans text-[11px] cursor-pointer transition-all",
        expanded ? "min-w-[260px] max-w-[320px]" : "min-w-[160px] max-w-[220px]"
      )}
      style={{
        background: isActive ? "rgba(109, 131, 166, 0.08)" : "hsl(220 16% 11%)",
        border: `1px solid ${color}${isActive ? "" : "40"}`,
        padding: "6px 10px",
      }}
    >
      <Handle type="target" position={Position.Left} style={{ background: color }} />

      <div className="flex items-center gap-1.5">
        {isActive && <span className="w-[5px] h-[5px] rounded-full bg-primary animate-pulse" />}
        <span className="rounded bg-secondary px-1 py-px text-[9px] font-semibold uppercase text-muted-foreground">{isCommand ? "cmd" : "agent"}</span>
        <span className="font-medium">{phase}</span>
        {index && <span className="text-muted-foreground/40">({index})</span>}
      </div>

      {(agent || command || model) && (
        <div className="mt-0.5 text-[9px] text-muted-foreground/60 overflow-hidden text-ellipsis whitespace-nowrap">
          {isCommand && command && <span className="text-primary">{command}</span>}
          {!isCommand && agent && <span className="text-foreground">{agent}</span>}
          {model && <span className="text-muted-foreground/30"> · {model.replace("kimi-code/", "")}</span>}
        </div>
      )}

      {expanded && (
        <div className="mt-2 pt-2 border-t border-border/30 text-[9px] space-y-1">
          {isCommand && command && (
            <div className="font-mono bg-background/50 p-1.5 rounded text-primary">
              $ {command} {data.command_args?.join(" ") || ""}
              {data.cwd_mode && <div className="text-muted-foreground/30">cwd: {data.cwd_mode}</div>}
              {data.timeout_secs && <div className="text-muted-foreground/30">timeout: {data.timeout_secs}s</div>}
            </div>
          )}
          {directive && (
            <div className="font-mono bg-background/50 p-1.5 rounded text-muted-foreground/70 max-h-[120px] overflow-auto whitespace-pre-wrap leading-[13px]">
              {directive}
            </div>
          )}
          {!directive && !command && <div className="text-muted-foreground/30 italic">No directive configured</div>}
        </div>
      )}

      <Handle type="source" position={Position.Right} style={{ background: color }} />
    </div>
  );
}
