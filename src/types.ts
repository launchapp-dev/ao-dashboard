export interface Project {
  name: string;
  root: string;
  enabled: boolean;
  teamId: string;
  teamSlug: string;
  teamName: string;
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
  project_root?: string;
  ts: string;
  level: string;
  cat: string;
  msg: string;
  role?: string;
  content?: string;
  error?: string;
  run_id?: string;
  workflow_id?: string;
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
  enabled: boolean;
  teamId: string;
  teamSlug: string;
  teamName: string;
  health: DaemonHealth | null;
  workflows: WorkflowInfo[];
  tasks: TaskSummary | null;
}

export interface FleetData {
  projects: FleetProject[];
}

export interface FleetTeamSummary {
  id: string;
  slug: string;
  name: string;
  mission: string;
  ownership: string;
  businessPriority: number;
}

export interface FleetTeamProjectRecord {
  id: string;
  teamId: string;
  slug: string;
  root: string;
  remoteUrl?: string | null;
  enabled: boolean;
}

export interface FleetTeamScheduleRecord {
  id: string;
  teamId: string;
  timezone: string;
  policyKind: string;
  windows: unknown;
  enabled: boolean;
}

export interface FleetTeamPlacementRecord {
  projectId: string;
  hostId: string;
  hostSlug?: string | null;
  hostName?: string | null;
  hostAddress?: string | null;
  hostStatus?: string | null;
  assignmentSource: string;
  assignedAt: string;
}

export interface FleetHostRecord {
  id: string;
  slug: string;
  name: string;
  address: string;
  status: string;
}

export interface FleetAuditEvent {
  id: string;
  teamId?: string | null;
  entityType: string;
  entityId: string;
  action: string;
  actorType: string;
  actorId?: string | null;
  summary: string;
  details: Record<string, unknown>;
  occurredAt: string;
}

export interface FleetKnowledgeDocument {
  id: string;
  scope: string;
  scopeRef?: string | null;
  kind: string;
  title: string;
  summary: string;
  body: string;
  tags: string[];
  updatedAt: string;
}

export interface FleetKnowledgeFact {
  id: string;
  scope: string;
  scopeRef?: string | null;
  kind: string;
  statement: string;
  confidence: number;
  tags: string[];
  observedAt: string;
}

export interface FleetTeamDaemonStatus {
  projectId: string;
  projectSlug: string;
  projectRoot: string;
  desiredState: string;
  observedState: string;
  checkedAt: string;
  source: string;
  details: Record<string, unknown>;
}

export interface FleetReconcileProjectResult {
  teamId: string;
  projectId: string;
  projectRoot: string;
  desiredState: string;
  observedState?: string | null;
  backlogCount: number;
  scheduleIds: string[];
  action?: string | null;
  target: Record<string, unknown>;
  commandResult?: Record<string, unknown> | null;
}

export interface FleetTeamReconcilePreview {
  evaluatedAt: string;
  apply: boolean;
  teamId?: string | null;
  results: FleetReconcileProjectResult[];
}

export interface FleetTeamSnapshot {
  team: FleetTeamSummary;
  projects: FleetTeamProjectRecord[];
  schedules: FleetTeamScheduleRecord[];
  placements: FleetTeamPlacementRecord[];
  hosts: FleetHostRecord[];
  daemonStatuses: FleetTeamDaemonStatus[];
  reconcilePreview: FleetTeamReconcilePreview;
  auditEvents: FleetAuditEvent[];
  knowledgeDocuments: FleetKnowledgeDocument[];
  knowledgeFacts: FleetKnowledgeFact[];
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

export interface TaskChecklistItem {
  id: string;
  description: string;
  completed: boolean;
  [key: string]: unknown;
}

export interface TaskMetadata {
  created_at?: string;
  updated_at?: string;
  created_by?: string;
  updated_by?: string;
  started_at?: string | null;
  completed_at?: string | null;
  version?: number;
  [key: string]: unknown;
}

export interface TaskRecord {
  id: string;
  title: string;
  description?: string | null;
  type?: string | null;
  status: string;
  priority: string;
  blocked_reason?: string | null;
  risk?: string | null;
  scope?: string | null;
  complexity?: string | null;
  impact_area?: string[];
  assignee?: Record<string, unknown> | null;
  estimated_effort?: unknown;
  linked_requirements?: unknown[];
  linked_architecture_entities?: unknown[];
  dependencies?: unknown[];
  checklist: TaskChecklistItem[];
  tags?: string[];
  workflow_metadata?: Record<string, unknown> | null;
  worktree_path?: string | null;
  branch_name?: string | null;
  metadata?: TaskMetadata | null;
  deadline?: string | null;
  paused?: boolean;
  cancelled?: boolean;
  resource_requirements?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface TaskStats {
  total: number;
  by_status: Record<string, number>;
  by_priority: Record<string, number>;
  by_type: Record<string, number>;
  in_progress: number;
  blocked: number;
  completed: number;
  stale_in_progress?: {
    threshold_hours: number;
    count: number;
    tasks: TaskRecord[];
  };
  priority_policy?: {
    high_budget_percent: number;
    high_budget_limit: number;
    total_tasks: number;
    active_tasks: number;
    total_by_priority: Record<string, number>;
    active_by_priority: Record<string, number>;
    high_budget_compliant: boolean;
    high_budget_overflow: number;
  };
}

export interface TaskCreatePayload {
  title: string;
  description?: string | null;
  task_type?: string | null;
  priority?: string | null;
}

export interface CommitInfo {
  hash: string;
  message: string;
  date: string;
}

export interface AoCommandInfo {
  name: string;
  about: string;
}

export interface AoCommandHelp {
  path: string[];
  about: string;
  usage: string;
  commands: AoCommandInfo[];
}

export interface AoSessionStarted {
  session_id: string;
  display_command: string;
}

export interface AoSessionOutput {
  session_id: string;
  stream: "stdout" | "stderr" | string;
  line: string;
}

export interface AoSessionExit {
  session_id: string;
  success: boolean;
  code: number | null;
}

export interface ProjectConfig {
  project: string;
  root: string;
  agents: AgentConfig[];
  phases: PhaseConfig[];
  workflows: WorkflowConfig[];
  schedules: ScheduleConfig[];
}

export interface AoSyncInfo {
  configured: boolean;
  server?: string;
  project_id?: string;
  last_synced_at?: string;
}

export interface AoProviderInfo {
  name: string;
  base_url?: string;
  configured: boolean;
}

export interface AoWorkflowTemplateInfo {
  id: string;
  name?: string;
  description?: string;
  phase_count: number;
  source_file: string;
}

export interface AoLogInfo {
  name: string;
  path: string;
  exists: boolean;
  size_bytes: number;
  modified_at_ms?: number;
  recent_lines: string[];
}

export interface GlobalAoInfo {
  ao_home: string;
  agent_runner_token_configured: boolean;
  sync: AoSyncInfo;
  providers: AoProviderInfo[];
  workflow_templates: AoWorkflowTemplateInfo[];
  logs: AoLogInfo[];
}
