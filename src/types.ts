export interface Project {
  name: string;
  root: string;
}

export interface DaemonHealth {
  project: string;
  root: string;
  status: string;
  active_agents: number;
  pool_size: number;
  queued_tasks: number;
  daemon_pid: number | null;
  pool_utilization_percent: number;
  healthy: boolean;
}

export interface StreamEvent {
  project: string;
  ts: string;
  level: string;
  cat: string;
  msg: string;
  subject_id?: string;
  phase_id?: string;
  task_id?: string;
  workflow_ref?: string;
  model?: string;
  tool?: string;
  schedule_id?: string;
  meta?: Record<string, unknown>;
}

export interface WorkflowInfo {
  id: string;
  task_id: string;
  workflow_ref: string;
  status: string;
  current_phase: string;
  phase_progress: string;
  project: string;
}

export interface TaskSummary {
  project: string;
  backlog: number;
  ready: number;
  blocked: number;
  done: number;
  cancelled: number;
  on_hold: number;
  in_progress: number;
  total: number;
}

export interface FleetProject {
  name: string;
  root: string;
  health: DaemonHealth | null;
  workflows: WorkflowInfo[];
  tasks: TaskSummary | null;
}

export interface FleetData {
  projects: FleetProject[];
}

export interface AgentConfig {
  name: string;
  model: string;
  tool: string;
  system_prompt?: string;
  mcp_servers: string[];
}

export interface PhaseConfig {
  id: string;
  mode: string;
  agent?: string;
  directive?: string;
  command?: string;
  command_args: string[];
  timeout_secs?: number;
  cwd_mode?: string;
}

export interface WorkflowConfig {
  id: string;
  name?: string;
  description?: string;
  phases: string[];
}

export interface ScheduleConfig {
  id: string;
  cron: string;
  workflow_ref: string;
  enabled: boolean;
}

export interface TaskInfo {
  id: string;
  title: string;
  status: string;
  priority: string;
}

export interface CommitInfo {
  hash: string;
  message: string;
  date: string;
}

export interface ProjectConfig {
  project: string;
  root: string;
  agents: AgentConfig[];
  phases: PhaseConfig[];
  workflows: WorkflowConfig[];
  schedules: ScheduleConfig[];
}
