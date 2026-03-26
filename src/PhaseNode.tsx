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
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          data.onToggle?.();
        }
      }}
      role="button"
      tabIndex={0}
      className={cn(
        "rounded-[16px] font-sans text-[11px] cursor-pointer transition-all",
        expanded ? "min-w-[260px] max-w-[320px]" : "min-w-[160px] max-w-[220px]"
      )}
      style={{
        background: isActive ? "rgba(109, 131, 166, 0.12)" : "linear-gradient(180deg, hsl(220 17% 12%), hsl(220 16% 10%))",
        border: `1px solid ${color}${isActive ? "" : "40"}`,
        padding: "8px 12px",
      }}
    >
      <Handle type="target" position={Position.Left} style={{ background: color }} />

      <div className="flex items-center gap-1.5">
        {isActive && <span className="w-[5px] h-[5px] rounded-full bg-primary animate-pulse" />}
        <span className="rounded-full bg-secondary px-2 py-0.5 text-[9px] font-semibold uppercase text-muted-foreground">{isCommand ? "cmd" : "agent"}</span>
        <span className="font-medium text-foreground">{phase}</span>
        {index && <span className="text-muted-foreground">{index}</span>}
      </div>

      {(agent || command || model) && (
        <div className="mt-1 overflow-hidden text-ellipsis whitespace-nowrap text-[10px] text-muted-foreground">
          {isCommand && command && <span className="text-primary">{command}</span>}
          {!isCommand && agent && <span className="text-foreground">{agent}</span>}
          {model && <span className="text-muted-foreground"> · {model.replace("kimi-code/", "")}</span>}
        </div>
      )}

      {expanded && (
        <div className="mt-2 space-y-1 border-t border-border/30 pt-2 text-[10px]">
          {isCommand && command && (
            <div className="font-mono bg-background/50 p-1.5 rounded text-primary">
              $ {command} {data.command_args?.join(" ") || ""}
              {data.cwd_mode && <div className="text-muted-foreground">cwd: {data.cwd_mode}</div>}
              {data.timeout_secs && <div className="text-muted-foreground">timeout: {data.timeout_secs}s</div>}
            </div>
          )}
          {directive && (
            <div className="max-h-[120px] overflow-auto whitespace-pre-wrap rounded bg-background/50 p-1.5 font-mono leading-[14px] text-muted-foreground">
              {directive}
            </div>
          )}
          {!directive && !command && <div className="italic text-muted-foreground">No directive configured</div>}
        </div>
      )}

      <Handle type="source" position={Position.Right} style={{ background: color }} />
    </div>
  );
}
