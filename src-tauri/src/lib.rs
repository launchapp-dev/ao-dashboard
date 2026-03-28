use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::Emitter;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::Mutex as AsyncMutex;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub name: String,
    pub root: String,
    pub enabled: bool,
    pub team_id: String,
    pub team_slug: String,
    pub team_name: String,
}

#[derive(Debug, Deserialize, Clone)]
struct FleetProjectRecord {
    pub team_id: String,
    pub slug: String,
    pub ao_project_root: String,
    pub enabled: bool,
}

#[derive(Debug, Deserialize, Clone)]
struct FleetTeamRecord {
    pub id: String,
    pub slug: String,
    pub name: String,
}

#[derive(Debug, Clone)]
struct FleetProjectSnapshot {
    pub team_id: String,
    pub team_slug: String,
    pub team_name: String,
    pub slug: String,
    pub ao_project_root: String,
    pub enabled: bool,
}

#[derive(Debug, Deserialize, Clone)]
struct FleetDaemonStatusRecord {
    pub project_id: String,
    pub project_slug: String,
    pub project_root: String,
    pub desired_state: String,
    pub observed_state: String,
    pub checked_at: String,
    pub source: String,
    pub details: serde_json::Value,
}

#[derive(Debug, Deserialize, Clone)]
struct FleetManagedProjectRecord {
    pub id: String,
    pub team_id: String,
    pub slug: String,
    pub ao_project_root: String,
    pub remote_url: Option<String>,
    pub enabled: bool,
}

#[derive(Debug, Deserialize, Clone)]
struct FleetScheduleRecord {
    pub id: String,
    pub team_id: String,
    pub timezone: String,
    pub policy_kind: String,
    pub windows: serde_json::Value,
    pub enabled: bool,
}

#[derive(Debug, Deserialize, Clone)]
struct FleetAuditEventRecord {
    pub id: String,
    pub team_id: Option<String>,
    pub entity_type: String,
    pub entity_id: String,
    pub action: String,
    pub actor_type: String,
    pub actor_id: Option<String>,
    pub summary: String,
    pub details: serde_json::Value,
    pub occurred_at: String,
}

#[derive(Debug, Deserialize, Clone)]
struct FleetProjectPlacementRecord {
    pub project_id: String,
    pub host_id: String,
    pub assignment_source: String,
    pub assigned_at: String,
}

#[derive(Debug, Deserialize, Clone)]
struct FleetHostRecord {
    pub id: String,
    pub slug: String,
    pub name: String,
    pub address: String,
    pub status: String,
}

#[derive(Debug, Deserialize, Clone)]
struct FleetKnowledgeDocumentRecord {
    pub id: String,
    pub scope: String,
    pub scope_ref: Option<String>,
    pub kind: String,
    pub title: String,
    pub summary: String,
    pub body: String,
    pub tags: Vec<String>,
    pub updated_at: String,
}

#[derive(Debug, Deserialize, Clone)]
struct FleetKnowledgeFactRecord {
    pub id: String,
    pub scope: String,
    pub scope_ref: Option<String>,
    pub kind: String,
    pub statement: String,
    pub confidence: u8,
    pub tags: Vec<String>,
    pub observed_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DaemonHealth {
    pub project: String,
    pub root: String,
    pub status: String,
    pub active_agents: i64,
    pub pool_size: i64,
    pub queued_tasks: i64,
    pub daemon_pid: Option<i64>,
    pub pool_utilization_percent: f64,
    pub healthy: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct StreamEvent {
    pub project: String,
    pub project_root: String,
    pub ts: String,
    pub level: String,
    pub cat: String,
    pub msg: String,
    pub role: Option<String>,
    pub content: Option<String>,
    pub error: Option<String>,
    pub run_id: Option<String>,
    pub workflow_id: Option<String>,
    pub subject_id: Option<String>,
    pub phase_id: Option<String>,
    pub task_id: Option<String>,
    pub workflow_ref: Option<String>,
    pub model: Option<String>,
    pub tool: Option<String>,
    pub schedule_id: Option<String>,
    pub meta: Option<serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AoCommandInfo {
    pub name: String,
    pub about: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AoCommandHelp {
    pub path: Vec<String>,
    pub about: String,
    pub usage: String,
    pub commands: Vec<AoCommandInfo>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AoSessionStarted {
    pub session_id: String,
    pub display_command: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AoSessionOutput {
    pub session_id: String,
    pub stream: String,
    pub line: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AoSessionExit {
    pub session_id: String,
    pub success: bool,
    pub code: Option<i32>,
}

#[derive(Default)]
struct AoSessionStore {
    next_id: AtomicU64,
    sessions: Mutex<HashMap<String, Arc<AsyncMutex<tokio::process::Child>>>>,
}

#[derive(Default)]
struct AoHelpCache {
    entries: Mutex<HashMap<String, AoCommandHelp>>,
}

#[derive(Default)]
struct StreamRegistry {
    active_projects: Arc<AsyncMutex<HashSet<String>>>,
    next_filtered_id: AtomicU64,
    filtered_streams: Arc<Mutex<HashMap<String, Arc<AsyncMutex<tokio::process::Child>>>>>,
}

const STREAM_TAIL_LINES: &str = "250";
const FILTERED_STREAM_TAIL_LINES: &str = "400";

fn ao_binary() -> String {
    let home = dirs::home_dir().unwrap_or_default();
    let local_bin = home.join(".local/bin/ao");
    if local_bin.exists() {
        return local_bin.to_string_lossy().to_string();
    }
    "ao".to_string()
}

fn ao_home_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("no home dir")?;
    Ok(home.join(".ao"))
}

fn fleet_repo_dir() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("AO_FLEET_REPO") {
        let repo = PathBuf::from(path);
        if repo.exists() {
            return Some(repo);
        }
    }

    let current = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let sibling = current.parent().map(|parent| parent.join("ao-fleet"));
    if let Some(repo) = sibling.filter(|repo| repo.exists()) {
        return Some(repo);
    }

    let home = dirs::home_dir()?;
    let repo = home.join("brain").join("repos").join("ao-fleet");
    if repo.exists() {
        return Some(repo);
    }

    None
}

fn fleet_db_path() -> Result<PathBuf, String> {
    if let Ok(path) = std::env::var("AO_FLEET_DB_PATH") {
        return Ok(PathBuf::from(path));
    }

    if let Some(repo) = fleet_repo_dir() {
        return Ok(repo.join("ao-fleet.db"));
    }

    Err("ao-fleet repo not found; set AO_FLEET_DB_PATH or AO_FLEET_REPO".to_string())
}

fn build_fleet_command(args: &[String]) -> Result<Command, String> {
    let db_path = fleet_db_path()?;

    if let Ok(path) = std::env::var("AO_FLEET_BINARY") {
        let mut command = Command::new(path);
        command.arg("--db-path").arg(&db_path).args(args);
        return Ok(command);
    }

    if let Some(home) = dirs::home_dir() {
        let local_bin = home.join(".local").join("bin").join("ao-fleet-cli");
        if local_bin.exists() {
            let mut command = Command::new(local_bin);
            command.arg("--db-path").arg(&db_path).args(args);
            return Ok(command);
        }
    }

    if let Some(repo) = fleet_repo_dir() {
        let mut command = Command::new("cargo");
        command
            .current_dir(repo)
            .args(["run", "-q", "-p", "ao-fleet-cli", "--"])
            .arg("--db-path")
            .arg(&db_path)
            .args(args);
        return Ok(command);
    }

    let mut command = Command::new("ao-fleet-cli");
    command.arg("--db-path").arg(&db_path).args(args);
    Ok(command)
}

fn read_json_value(path: &Path) -> Option<serde_json::Value> {
    let content = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

fn file_modified_ms(path: &Path) -> Option<u64> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    let since_epoch = modified.duration_since(std::time::UNIX_EPOCH).ok()?;
    Some(since_epoch.as_millis() as u64)
}

fn sanitize_log_line(line: &str) -> Option<String> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }

    let lowered = trimmed.to_ascii_lowercase();
    if lowered.contains("api_key")
        || lowered.contains("authorization:")
        || lowered.contains("bearer ")
        || lowered.contains(" token")
        || lowered.starts_with("token")
        || trimmed.contains("sk-")
    {
        return Some("[redacted sensitive log line]".to_string());
    }

    let mut value = trimmed.to_string();
    if value.len() > 180 {
        value.truncate(177);
        value.push_str("...");
    }
    Some(value)
}

fn read_recent_lines(path: &Path, count: usize) -> Vec<String> {
    let Ok(content) = std::fs::read_to_string(path) else {
        return Vec::new();
    };

    content
        .lines()
        .rev()
        .filter_map(sanitize_log_line)
        .take(count)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect()
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AoSyncInfo {
    pub configured: bool,
    pub server: Option<String>,
    pub project_id: Option<String>,
    pub last_synced_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AoProviderInfo {
    pub name: String,
    pub base_url: Option<String>,
    pub configured: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AoWorkflowTemplateInfo {
    pub id: String,
    pub name: Option<String>,
    pub description: Option<String>,
    pub phase_count: usize,
    pub source_file: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AoLogInfo {
    pub name: String,
    pub path: String,
    pub exists: bool,
    pub size_bytes: u64,
    pub modified_at_ms: Option<u64>,
    pub recent_lines: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GlobalAoInfo {
    pub ao_home: String,
    pub agent_runner_token_configured: bool,
    pub sync: AoSyncInfo,
    pub providers: Vec<AoProviderInfo>,
    pub workflow_templates: Vec<AoWorkflowTemplateInfo>,
    pub logs: Vec<AoLogInfo>,
}

fn load_global_workflow_templates(workflows_dir: &Path) -> Vec<AoWorkflowTemplateInfo> {
    let Ok(entries) = std::fs::read_dir(workflows_dir) else {
        return Vec::new();
    };

    let mut templates = Vec::new();

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("yaml") {
            continue;
        }

        let Ok(content) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(value) = serde_yaml::from_str::<serde_json::Value>(&content) else {
            continue;
        };
        let Some(workflows) = value.get("workflows").and_then(|w| w.as_array()) else {
            continue;
        };

        for workflow in workflows {
            let Some(id) = workflow.get("id").and_then(|v| v.as_str()) else {
                continue;
            };

            let phase_count = workflow
                .get("phases")
                .and_then(|v| v.as_array())
                .map(|phases| phases.len())
                .unwrap_or(0);

            templates.push(AoWorkflowTemplateInfo {
                id: id.to_string(),
                name: workflow
                    .get("name")
                    .and_then(|v| v.as_str())
                    .map(String::from),
                description: workflow
                    .get("description")
                    .and_then(|v| v.as_str())
                    .map(String::from),
                phase_count,
                source_file: path
                    .file_name()
                    .map(|name| name.to_string_lossy().to_string())
                    .unwrap_or_else(|| path.to_string_lossy().to_string()),
            });
        }
    }

    templates.sort_by(|a, b| a.id.cmp(&b.id));
    templates
}

fn summarize_log_file(path: &Path, name: &str) -> AoLogInfo {
    let metadata = std::fs::metadata(path).ok();
    AoLogInfo {
        name: name.to_string(),
        path: path.to_string_lossy().to_string(),
        exists: metadata.is_some(),
        size_bytes: metadata.as_ref().map(|m| m.len()).unwrap_or(0),
        modified_at_ms: file_modified_ms(path),
        recent_lines: read_recent_lines(path, 3),
    }
}

async fn load_fleet_projects() -> Result<Vec<FleetProjectSnapshot>, String> {
    let project_data = run_fleet_json_cmd_str(&["project-list"], 15).await?;
    let team_data = run_fleet_json_cmd_str(&["team-list"], 15).await?;
    let mut projects: Vec<FleetProjectRecord> =
        serde_json::from_value(project_data).map_err(|error| error.to_string())?;
    let teams: Vec<FleetTeamRecord> =
        serde_json::from_value(team_data).map_err(|error| error.to_string())?;
    let team_map = teams
        .into_iter()
        .map(|team| (team.id.clone(), team))
        .collect::<HashMap<_, _>>();

    let mut snapshots = projects
        .drain(..)
        .map(|project| {
            let team = team_map.get(&project.team_id);
            FleetProjectSnapshot {
                team_id: project.team_id.clone(),
                team_slug: team
                    .map(|record| record.slug.clone())
                    .unwrap_or_else(|| "unassigned".to_string()),
                team_name: team
                    .map(|record| record.name.clone())
                    .unwrap_or_else(|| "Unassigned".to_string()),
                slug: project.slug,
                ao_project_root: project.ao_project_root,
                enabled: project.enabled,
            }
        })
        .collect::<Vec<_>>();
    snapshots.sort_by(|left, right| {
        left.team_slug
            .cmp(&right.team_slug)
            .then(left.slug.cmp(&right.slug))
    });
    Ok(snapshots)
}

fn parse_fleet_health_value(status: &FleetDaemonStatusRecord) -> DaemonHealth {
    let fleet_status = if status.observed_state.trim().is_empty() {
        "offline".to_string()
    } else {
        status.observed_state.clone()
    };

    DaemonHealth {
        project: status.project_slug.clone(),
        root: status.project_root.clone(),
        status: fleet_status.clone(),
        active_agents: 0,
        pool_size: 0,
        queued_tasks: 0,
        daemon_pid: None,
        pool_utilization_percent: 0.0,
        healthy: fleet_status == "running",
    }
}

#[tauri::command]
async fn discover_projects() -> Result<Vec<Project>, String> {
    let projects = load_fleet_projects().await?;

    Ok(projects
        .into_iter()
        .map(|project| Project {
            name: project.slug,
            root: project.ao_project_root,
            enabled: project.enabled,
            team_id: project.team_id,
            team_slug: project.team_slug,
            team_name: project.team_name,
        })
        .collect())
}

#[tauri::command]
async fn get_global_ao_info() -> Result<GlobalAoInfo, String> {
    let ao_dir = ao_home_dir()?;
    let config = read_json_value(&ao_dir.join("config.json")).unwrap_or_default();
    let sync = read_json_value(&ao_dir.join("sync.json")).unwrap_or_default();
    let credentials = read_json_value(&ao_dir.join("credentials.json")).unwrap_or_default();

    let agent_runner_token_configured = config
        .get("agent_runner_token")
        .and_then(|v| v.as_str())
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false);

    let sync_server = sync
        .get("server")
        .and_then(|v| v.as_str())
        .map(String::from);
    let sync_token_configured = sync
        .get("token")
        .and_then(|v| v.as_str())
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false);

    let mut providers = credentials
        .get("providers")
        .and_then(|v| v.as_object())
        .map(|providers_map| {
            providers_map
                .iter()
                .map(|(name, value)| AoProviderInfo {
                    name: name.clone(),
                    base_url: value
                        .get("base_url")
                        .and_then(|v| v.as_str())
                        .map(String::from),
                    configured: value
                        .get("api_key")
                        .and_then(|v| v.as_str())
                        .map(|api_key| !api_key.trim().is_empty())
                        .unwrap_or(false),
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    providers.sort_by(|a, b| a.name.cmp(&b.name));

    Ok(GlobalAoInfo {
        ao_home: ao_dir.to_string_lossy().to_string(),
        agent_runner_token_configured,
        sync: AoSyncInfo {
            configured: sync_server.is_some() && sync_token_configured,
            server: sync_server,
            project_id: sync
                .get("project_id")
                .and_then(|v| v.as_str())
                .map(String::from),
            last_synced_at: sync
                .get("last_synced_at")
                .and_then(|v| v.as_str())
                .map(String::from),
        },
        providers,
        workflow_templates: load_global_workflow_templates(&ao_dir.join("workflows")),
        logs: vec![
            summarize_log_file(&ao_dir.join("monitor.log"), "monitor.log"),
            summarize_log_file(&ao_dir.join("cleanup.log"), "cleanup.log"),
        ],
    })
}

async fn run_fleet_cmd(args: &[String], timeout_secs: u64) -> Result<String, String> {
    let mut command = build_fleet_command(args)?;
    command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let child = command.spawn().map_err(|e| e.to_string())?;
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(timeout_secs),
        child.wait_with_output(),
    )
    .await
    .map_err(|_| "timeout".to_string())?
    .map_err(|e| e.to_string())?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

    if output.status.success() {
        Ok(stdout)
    } else if !stderr.is_empty() {
        Err(stderr)
    } else {
        Err(stdout.trim().to_string())
    }
}

async fn run_fleet_cmd_str(args: &[&str], timeout_secs: u64) -> Result<String, String> {
    let args = args
        .iter()
        .map(|value| (*value).to_string())
        .collect::<Vec<_>>();
    run_fleet_cmd(&args, timeout_secs).await
}

async fn run_fleet_json_cmd_str(
    args: &[&str],
    timeout_secs: u64,
) -> Result<serde_json::Value, String> {
    let stdout = run_fleet_cmd_str(args, timeout_secs).await?;
    serde_json::from_str(&stdout).map_err(|error| {
        format!(
            "failed to parse fleet json output: {error}: {}",
            stdout.lines().next().unwrap_or("")
        )
    })
}

async fn run_fleet_json_cmd(
    args: &[String],
    timeout_secs: u64,
) -> Result<serde_json::Value, String> {
    let stdout = run_fleet_cmd(args, timeout_secs).await?;
    serde_json::from_str(&stdout).map_err(|error| {
        format!(
            "failed to parse fleet json output: {error}: {}",
            stdout.lines().next().unwrap_or("")
        )
    })
}

async fn run_fleet_project_json_cmd(
    project_root: &str,
    command_args: &[String],
    timeout_secs: u64,
) -> Result<serde_json::Value, String> {
    let mut args = vec![
        "project-ao-json".to_string(),
        "--project-root".to_string(),
        project_root.to_string(),
        "--".to_string(),
    ];
    args.extend(command_args.iter().cloned());
    let stdout = run_fleet_cmd(&args, timeout_secs).await?;
    serde_json::from_str(&stdout).map_err(|error| {
        format!(
            "failed to parse fleet project json output: {error}: {}",
            stdout.lines().next().unwrap_or("")
        )
    })
}

async fn run_fleet_project_config_cmd(project_root: &str) -> Result<serde_json::Value, String> {
    run_fleet_json_cmd_str(&["project-config-get", "--project-root", project_root], 15).await
}

async fn run_fleet_project_events_cmd(
    project_root: &str,
    workflow: Option<&str>,
    run: Option<&str>,
    cat: Option<&str>,
    level: Option<&str>,
    tail: &str,
) -> Result<Vec<StreamEvent>, String> {
    let mut args = vec![
        "project-events".to_string(),
        "--project-root".to_string(),
        project_root.to_string(),
        "--tail".to_string(),
        tail.to_string(),
    ];

    if let Some(value) = workflow.filter(|value| !value.is_empty()) {
        args.push("--workflow".to_string());
        args.push(value.to_string());
    } else if let Some(value) = run.filter(|value| !value.is_empty()) {
        args.push("--run".to_string());
        args.push(value.to_string());
    }

    if let Some(value) = cat.filter(|value| !value.is_empty()) {
        args.push("--cat".to_string());
        args.push(value.to_string());
    }

    if let Some(value) = level.filter(|value| !value.is_empty() && *value != "all") {
        args.push("--level".to_string());
        args.push(value.to_string());
    }

    let stdout = run_fleet_cmd(&args, 15).await?;
    serde_json::from_str(&stdout).map_err(|error| {
        format!(
            "failed to parse fleet project events output: {error}: {}",
            stdout.lines().next().unwrap_or("")
        )
    })
}

fn extract_ao_error(envelope: &serde_json::Value, stdout: &str) -> String {
    envelope["error"]["message"]
        .as_str()
        .or_else(|| envelope["error"].as_str())
        .map(String::from)
        .unwrap_or_else(|| stdout.trim().to_string())
}

async fn run_ao_json_cmd(args: &[String], timeout_secs: u64) -> Result<serde_json::Value, String> {
    let mut command = Command::new(ao_binary());
    command
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);

    let child = command.spawn().map_err(|e| e.to_string())?;
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(timeout_secs),
        child.wait_with_output(),
    )
    .await
    .map_err(|_| "timeout".to_string())?
    .map_err(|e| e.to_string())?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let envelope: serde_json::Value = serde_json::from_str(&stdout).map_err(|e| {
        format!(
            "failed to parse AO json output: {e}: {}",
            stdout.lines().next().unwrap_or("")
        )
    })?;

    if envelope["ok"].as_bool().unwrap_or(false) {
        Ok(envelope
            .get("data")
            .cloned()
            .unwrap_or(serde_json::Value::Null))
    } else {
        Err(extract_ao_error(&envelope, &stdout))
    }
}

async fn run_ao_json_cmd_str(
    args: &[&str],
    timeout_secs: u64,
) -> Result<serde_json::Value, String> {
    let args = args
        .iter()
        .map(|value| (*value).to_string())
        .collect::<Vec<_>>();
    run_ao_json_cmd(&args, timeout_secs).await
}

fn parse_help_output(path: Vec<String>, stdout: &str) -> AoCommandHelp {
    let mut lines = stdout.lines();
    let about = lines.next().unwrap_or("").trim().to_string();
    let usage = stdout
        .lines()
        .find_map(|line| {
            line.strip_prefix("Usage:")
                .map(|rest| rest.trim().to_string())
        })
        .unwrap_or_default();

    let mut commands = Vec::new();
    let mut in_commands = false;

    for line in stdout.lines() {
        let trimmed = line.trim_end();
        if trimmed == "Commands:" {
            in_commands = true;
            continue;
        }

        if !in_commands {
            continue;
        }

        if trimmed.is_empty() {
            continue;
        }

        if !line.starts_with("  ") {
            break;
        }

        let content = trimmed.trim_start();
        if content.starts_with('-') {
            break;
        }

        let mut parts = content.splitn(2, "  ");
        let name = parts.next().unwrap_or("").trim();
        if name.is_empty() {
            continue;
        }

        let about = parts
            .next()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("")
            .to_string();

        commands.push(AoCommandInfo {
            name: name.to_string(),
            about,
        });
    }

    AoCommandHelp {
        path,
        about,
        usage,
        commands,
    }
}

fn build_fleet_args(path: &[String], extra_args: &[String]) -> Vec<String> {
    let mut args = Vec::new();
    args.extend(path.iter().cloned());
    args.extend(extra_args.iter().cloned());
    args
}

async fn emit_pipe_lines<R: tokio::io::AsyncRead + Unpin>(
    app: tauri::AppHandle,
    session_id: String,
    stream: &'static str,
    reader: R,
) {
    let mut lines = BufReader::new(reader).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let _ = app.emit(
            "ao-session-output",
            AoSessionOutput {
                session_id: session_id.clone(),
                stream: stream.to_string(),
                line,
            },
        );
    }
}

#[tauri::command]
async fn get_ao_help(
    cache: tauri::State<'_, AoHelpCache>,
    path: Vec<String>,
) -> Result<AoCommandHelp, String> {
    let cache_key = path.join("\0");
    if let Some(help) = cache
        .entries
        .lock()
        .map_err(|_| "help cache poisoned".to_string())?
        .get(&cache_key)
        .cloned()
    {
        return Ok(help);
    }

    let mut args: Vec<&str> = path.iter().map(String::as_str).collect();
    args.push("--help");
    let stdout = run_fleet_cmd_str(&args, 10).await?;
    let help = parse_help_output(path, &stdout);

    cache
        .entries
        .lock()
        .map_err(|_| "help cache poisoned".to_string())?
        .insert(cache_key, help.clone());

    Ok(help)
}

#[tauri::command]
async fn start_ao_session(
    app: tauri::AppHandle,
    store: tauri::State<'_, Arc<AoSessionStore>>,
    path: Vec<String>,
    _project_root: Option<String>,
    extra_args: Option<String>,
    _json: bool,
) -> Result<AoSessionStarted, String> {
    if path.is_empty() {
        return Err("command path is required".to_string());
    }

    let parsed_extra = extra_args
        .as_deref()
        .map(|raw| shlex::split(raw).ok_or_else(|| "failed to parse extra args".to_string()))
        .transpose()?
        .unwrap_or_default();
    let args = build_fleet_args(&path, &parsed_extra);

    let mut command = build_fleet_command(&args)?;
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "failed to capture stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "failed to capture stderr".to_string())?;

    let session_id = store.next_id.fetch_add(1, Ordering::Relaxed).to_string();
    let child = Arc::new(AsyncMutex::new(child));

    {
        let mut sessions = store
            .sessions
            .lock()
            .map_err(|_| "session store poisoned".to_string())?;
        sessions.insert(session_id.clone(), child.clone());
    }

    let output_app = app.clone();
    let output_session_id = session_id.clone();
    tokio::spawn(async move {
        emit_pipe_lines(output_app, output_session_id, "stdout", stdout).await;
    });

    let error_app = app.clone();
    let error_session_id = session_id.clone();
    tokio::spawn(async move {
        emit_pipe_lines(error_app, error_session_id, "stderr", stderr).await;
    });

    let wait_app = app.clone();
    let wait_session_id = session_id.clone();
    let wait_store = store.inner().clone();
    tokio::spawn(async move {
        let status = {
            let mut guard = child.lock().await;
            guard.wait().await
        };

        if let Ok(mut sessions) = wait_store.sessions.lock() {
            sessions.remove(&wait_session_id);
        }

        let (success, code) = match status {
            Ok(status) => (status.success(), status.code()),
            Err(_) => (false, None),
        };

        let _ = wait_app.emit(
            "ao-session-exit",
            AoSessionExit {
                session_id: wait_session_id,
                success,
                code,
            },
        );
    });

    Ok(AoSessionStarted {
        session_id,
        display_command: format!(
            "ao-fleet-cli --db-path {} {}",
            fleet_db_path()?.display(),
            args.join(" ")
        ),
    })
}

#[tauri::command]
async fn stop_ao_session(
    store: tauri::State<'_, Arc<AoSessionStore>>,
    session_id: String,
) -> Result<(), String> {
    let child = {
        let sessions = store
            .sessions
            .lock()
            .map_err(|_| "session store poisoned".to_string())?;
        sessions.get(&session_id).cloned()
    }
    .ok_or_else(|| "session not found".to_string())?;

    let mut guard = child.lock().await;
    guard.kill().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn write_ao_session_stdin(
    store: tauri::State<'_, Arc<AoSessionStore>>,
    session_id: String,
    input: String,
) -> Result<(), String> {
    let child = {
        let sessions = store
            .sessions
            .lock()
            .map_err(|_| "session store poisoned".to_string())?;
        sessions.get(&session_id).cloned()
    }
    .ok_or_else(|| "session not found".to_string())?;

    let mut guard = child.lock().await;
    let stdin = guard
        .stdin
        .as_mut()
        .ok_or_else(|| "stdin unavailable for session".to_string())?;
    stdin
        .write_all(input.as_bytes())
        .await
        .map_err(|e| e.to_string())
}

fn project_name_from_root(project_root: &str) -> String {
    PathBuf::from(project_root)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default()
}

fn parse_health_value(project_root: &str, val: &serde_json::Value) -> DaemonHealth {
    DaemonHealth {
        project: project_name_from_root(project_root),
        root: project_root.to_string(),
        status: val["status"].as_str().unwrap_or("unknown").to_string(),
        active_agents: val["active_agents"].as_i64().unwrap_or(0),
        pool_size: val["pool_size"].as_i64().unwrap_or(0),
        queued_tasks: val["queued_tasks"].as_i64().unwrap_or(0),
        daemon_pid: val["daemon_pid"].as_i64(),
        pool_utilization_percent: val["pool_utilization_percent"].as_f64().unwrap_or(0.0),
        healthy: val["healthy"].as_bool().unwrap_or(false),
    }
}

#[tauri::command]
async fn get_health(project_root: String) -> Result<DaemonHealth, String> {
    let data = run_ao_json_cmd_str(
        &[
            "daemon",
            "health",
            "--json",
            "--project-root",
            &project_root,
        ],
        5,
    )
    .await?;
    Ok(parse_health_value(&project_root, &data))
}

#[tauri::command]
async fn get_all_health(projects: Vec<Project>) -> Result<Vec<DaemonHealth>, String> {
    let mut handles = Vec::new();

    for project in projects {
        let root = project.root.clone();
        let name = project.name.clone();
        handles.push(tokio::spawn(async move {
            match run_ao_json_cmd_str(&["daemon", "health", "--json", "--project-root", &root], 30)
                .await
            {
                Ok(data) => {
                    let mut h = parse_health_value(&root, &data);
                    h.project = name;
                    h
                }
                Err(_) => DaemonHealth {
                    project: name,
                    root: root.clone(),
                    status: "offline".to_string(),
                    active_agents: 0,
                    pool_size: 0,
                    queued_tasks: 0,
                    daemon_pid: None,
                    pool_utilization_percent: 0.0,
                    healthy: false,
                },
            }
        }));
    }

    let mut results = Vec::new();
    for handle in handles {
        if let Ok(h) = handle.await {
            results.push(h);
        }
    }
    results.sort_by(|a, b| a.project.cmp(&b.project));
    Ok(results)
}

#[tauri::command]
async fn start_stream(
    app: tauri::AppHandle,
    streams: tauri::State<'_, StreamRegistry>,
    project_root: String,
) -> Result<(), String> {
    let project_name = project_name_from_root(&project_root);
    let stream_key = project_root.clone();
    let active_projects = streams.active_projects.clone();

    {
        let mut active = active_projects.lock().await;
        if !active.insert(stream_key.clone()) {
            return Ok(());
        }
    }

    tokio::spawn(async move {
        let args = vec![
            "project-events".to_string(),
            "--project-root".to_string(),
            project_root.clone(),
            "--tail".to_string(),
            STREAM_TAIL_LINES.to_string(),
            "--follow".to_string(),
        ];
        let mut command = match build_fleet_command(&args) {
            Ok(command) => command,
            Err(error) => {
                eprintln!("stream setup error for {project_name}: {error}");
                let mut active = active_projects.lock().await;
                active.remove(&stream_key);
                return;
            }
        };
        command
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);

        let mut child = match command.spawn() {
            Ok(c) => c,
            Err(e) => {
                eprintln!("stream spawn error for {project_name}: {e}");
                let mut active = active_projects.lock().await;
                active.remove(&stream_key);
                return;
            }
        };

        if let Some(stdout) = child.stdout.take() {
            let reader = BufReader::new(stdout);
            let mut lines = reader.lines();

            while let Ok(Some(line)) = lines.next_line().await {
                if let Ok(event) = serde_json::from_str::<StreamEvent>(&line) {
                    let _ = app.emit("stream-event", &event);
                }
            }
        }

        let mut active = active_projects.lock().await;
        active.remove(&stream_key);
    });

    Ok(())
}

#[tauri::command]
async fn get_recent_events(project_root: String) -> Result<Vec<StreamEvent>, String> {
    run_fleet_project_events_cmd(&project_root, None, None, None, None, STREAM_TAIL_LINES).await
}

#[tauri::command]
async fn get_filtered_events(
    project_root: String,
    workflow: Option<String>,
    run: Option<String>,
    cat: Option<String>,
    level: Option<String>,
) -> Result<Vec<StreamEvent>, String> {
    run_fleet_project_events_cmd(
        &project_root,
        workflow.as_deref(),
        run.as_deref(),
        cat.as_deref(),
        level.as_deref(),
        FILTERED_STREAM_TAIL_LINES,
    )
    .await
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WorkflowInfo {
    pub id: String,
    pub task_id: String,
    pub workflow_ref: String,
    pub status: String,
    pub current_phase: String,
    pub phase_progress: String,
    pub project: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TaskSummary {
    pub project: String,
    pub backlog: i64,
    pub ready: i64,
    pub blocked: i64,
    pub done: i64,
    pub cancelled: i64,
    pub on_hold: i64,
    pub in_progress: i64,
    pub total: i64,
}

#[tauri::command]
async fn get_workflows(project_root: String) -> Result<Vec<WorkflowInfo>, String> {
    let project_name = project_name_from_root(&project_root);
    let data = run_fleet_project_json_cmd(
        &project_root,
        &["workflow".to_string(), "list".to_string()],
        5,
    )
    .await?;
    let val = data.as_array().cloned().unwrap_or_default();

    Ok(val
        .iter()
        .filter(|w| w["status"].as_str() == Some("running"))
        .map(|w| {
            let phases_total = w["phases"].as_array().map(|a| a.len()).unwrap_or(0);
            let current_idx = w["current_phase_index"].as_u64().unwrap_or(0) as usize;
            let current_phase = w["phases"]
                .as_array()
                .and_then(|a| a.get(current_idx))
                .and_then(|p| p["phase_id"].as_str().or(p.as_str()))
                .unwrap_or("unknown")
                .to_string();

            WorkflowInfo {
                id: w["id"].as_str().unwrap_or("").to_string(),
                task_id: w["task_id"].as_str().unwrap_or("cron").to_string(),
                workflow_ref: w["workflow_ref"].as_str().unwrap_or("?").to_string(),
                status: w["status"].as_str().unwrap_or("unknown").to_string(),
                current_phase,
                phase_progress: format!("{}/{}", current_idx + 1, phases_total),
                project: project_name.clone(),
            }
        })
        .collect())
}

#[tauri::command]
async fn get_task_summary(project_root: String) -> Result<TaskSummary, String> {
    let project_name = project_name_from_root(&project_root);
    let data =
        run_fleet_project_json_cmd(&project_root, &["task".to_string(), "stats".to_string()], 5)
            .await?;
    let by_status = data["by_status"].as_object().cloned().unwrap_or_default();

    Ok(TaskSummary {
        project: project_name,
        backlog: by_status
            .get("backlog")
            .and_then(|value| value.as_i64())
            .unwrap_or(0),
        ready: by_status
            .get("ready")
            .and_then(|value| value.as_i64())
            .unwrap_or(0),
        blocked: by_status
            .get("blocked")
            .and_then(|value| value.as_i64())
            .unwrap_or(0),
        done: by_status
            .get("done")
            .and_then(|value| value.as_i64())
            .unwrap_or(0),
        cancelled: by_status
            .get("cancelled")
            .and_then(|value| value.as_i64())
            .unwrap_or(0),
        on_hold: by_status
            .get("on_hold")
            .or_else(|| by_status.get("on-hold"))
            .and_then(|value| value.as_i64())
            .unwrap_or(0),
        in_progress: by_status
            .get("in_progress")
            .or_else(|| by_status.get("in-progress"))
            .and_then(|value| value.as_i64())
            .unwrap_or(0),
        total: data["total"].as_i64().unwrap_or(0),
    })
}

#[tauri::command]
async fn get_fleet_data() -> Result<serde_json::Value, String> {
    let projects = load_fleet_projects().await?;
    let statuses_value = run_fleet_json_cmd_str(&["daemon-status", "--refresh"], 30).await?;
    let statuses: Vec<FleetDaemonStatusRecord> =
        serde_json::from_value(statuses_value).map_err(|error| error.to_string())?;
    let status_by_root = statuses
        .into_iter()
        .map(|status| (status.project_root.clone(), status))
        .collect::<HashMap<_, _>>();

    let fleet = projects
        .into_iter()
        .map(|project| {
            let health = status_by_root
                .get(&project.ao_project_root)
                .map(parse_fleet_health_value);

            serde_json::json!({
                "name": project.slug,
                "root": project.ao_project_root,
                "enabled": project.enabled,
                "teamId": project.team_id,
                "teamSlug": project.team_slug,
                "teamName": project.team_name,
                "health": health,
                "workflows": [],
                "tasks": serde_json::Value::Null,
            })
        })
        .collect::<Vec<_>>();

    Ok(serde_json::json!({ "projects": fleet }))
}

#[tauri::command]
async fn get_team_snapshot(team_id: String) -> Result<serde_json::Value, String> {
    let team = run_fleet_json_cmd_str(&["team-get", "--id", &team_id], 10).await?;
    let projects_value = run_fleet_json_cmd_str(&["project-list"], 15).await?;
    let schedules_value =
        run_fleet_json_cmd_str(&["schedule-list", "--team-id", &team_id], 10).await?;
    let audits_value =
        run_fleet_json_cmd_str(&["audit-list", "--team-id", &team_id, "--limit", "40"], 10).await?;
    let placements_value = run_fleet_json_cmd_str(&["project-host-list"], 10).await?;
    let hosts_value = run_fleet_json_cmd_str(&["host-list"], 10).await?;
    let statuses_value =
        run_fleet_json_cmd_str(&["daemon-status", "--refresh", "--team-id", &team_id], 20).await?;
    let reconcile_value =
        run_fleet_json_cmd_str(&["daemon-reconcile", "--team-id", &team_id], 20).await?;
    let knowledge_documents_value = run_fleet_json_cmd_str(
        &[
            "knowledge-document-list",
            "--scope",
            "team",
            "--scope-ref",
            &team_id,
            "--limit",
            "12",
        ],
        10,
    )
    .await?;
    let knowledge_facts_value = run_fleet_json_cmd_str(
        &[
            "knowledge-fact-list",
            "--scope",
            "team",
            "--scope-ref",
            &team_id,
            "--limit",
            "20",
        ],
        10,
    )
    .await?;

    let projects: Vec<FleetManagedProjectRecord> =
        serde_json::from_value(projects_value).map_err(|error| error.to_string())?;
    let schedules: Vec<FleetScheduleRecord> =
        serde_json::from_value(schedules_value).map_err(|error| error.to_string())?;
    let audits: Vec<FleetAuditEventRecord> =
        serde_json::from_value(audits_value).map_err(|error| error.to_string())?;
    let placements: Vec<FleetProjectPlacementRecord> =
        serde_json::from_value(placements_value).map_err(|error| error.to_string())?;
    let hosts: Vec<FleetHostRecord> =
        serde_json::from_value(hosts_value.clone()).map_err(|error| error.to_string())?;
    let statuses: Vec<FleetDaemonStatusRecord> =
        serde_json::from_value(statuses_value).map_err(|error| error.to_string())?;
    let knowledge_documents: Vec<FleetKnowledgeDocumentRecord> =
        serde_json::from_value(knowledge_documents_value).map_err(|error| error.to_string())?;
    let knowledge_facts: Vec<FleetKnowledgeFactRecord> =
        serde_json::from_value(knowledge_facts_value).map_err(|error| error.to_string())?;

    let relevant_projects = projects
        .into_iter()
        .filter(|project| project.team_id == team_id)
        .collect::<Vec<_>>();
    let relevant_project_ids = relevant_projects
        .iter()
        .map(|project| project.id.clone())
        .collect::<HashSet<_>>();
    let hosts_by_id = hosts
        .iter()
        .cloned()
        .map(|host| (host.id.clone(), host))
        .collect::<HashMap<_, _>>();

    let project_rows = relevant_projects
        .iter()
        .map(|project| {
            serde_json::json!({
                "id": project.id,
                "teamId": project.team_id,
                "slug": project.slug,
                "root": project.ao_project_root,
                "remoteUrl": project.remote_url,
                "enabled": project.enabled,
            })
        })
        .collect::<Vec<_>>();

    let schedule_rows = schedules
        .into_iter()
        .filter(|schedule| schedule.team_id == team_id)
        .map(|schedule| {
            serde_json::json!({
                "id": schedule.id,
                "teamId": schedule.team_id,
                "timezone": schedule.timezone,
                "policyKind": schedule.policy_kind,
                "windows": schedule.windows,
                "enabled": schedule.enabled,
            })
        })
        .collect::<Vec<_>>();

    let placement_rows = placements
        .into_iter()
        .filter(|placement| relevant_project_ids.contains(&placement.project_id))
        .map(|placement| {
            let host = hosts_by_id.get(&placement.host_id);
            serde_json::json!({
                "projectId": placement.project_id,
                "hostId": placement.host_id,
                "hostSlug": host.map(|host| host.slug.clone()),
                "hostName": host.map(|host| host.name.clone()),
                "hostAddress": host.map(|host| host.address.clone()),
                "hostStatus": host.map(|host| host.status.clone()),
                "assignmentSource": placement.assignment_source,
                "assignedAt": placement.assigned_at,
            })
        })
        .collect::<Vec<_>>();

    let audit_rows = audits
        .into_iter()
        .map(|audit| {
            serde_json::json!({
                "id": audit.id,
                "teamId": audit.team_id,
                "entityType": audit.entity_type,
                "entityId": audit.entity_id,
                "action": audit.action,
                "actorType": audit.actor_type,
                "actorId": audit.actor_id,
                "summary": audit.summary,
                "details": audit.details,
                "occurredAt": audit.occurred_at,
            })
        })
        .collect::<Vec<_>>();

    let status_rows = statuses
        .into_iter()
        .map(|status| {
            serde_json::json!({
                "projectId": status.project_id,
                "projectSlug": status.project_slug,
                "projectRoot": status.project_root,
                "desiredState": status.desired_state,
                "observedState": status.observed_state,
                "checkedAt": status.checked_at,
                "source": status.source,
                "details": status.details,
            })
        })
        .collect::<Vec<_>>();

    let host_rows = hosts
        .into_iter()
        .map(|host| {
            serde_json::json!({
                "id": host.id,
                "slug": host.slug,
                "name": host.name,
                "address": host.address,
                "status": host.status,
            })
        })
        .collect::<Vec<_>>();

    let knowledge_document_rows = knowledge_documents
        .into_iter()
        .map(|document| {
            serde_json::json!({
                "id": document.id,
                "scope": document.scope,
                "scopeRef": document.scope_ref,
                "kind": document.kind,
                "title": document.title,
                "summary": document.summary,
                "body": document.body,
                "tags": document.tags,
                "updatedAt": document.updated_at,
            })
        })
        .collect::<Vec<_>>();

    let reconcile_rows = reconcile_value["results"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|result| {
            serde_json::json!({
                "teamId": result["team_id"].as_str(),
                "projectId": result["project_id"].as_str(),
                "projectRoot": result["project_root"].as_str(),
                "desiredState": result["desired_state"].as_str(),
                "observedState": result["observed_state"].as_str(),
                "backlogCount": result["backlog_count"].as_u64(),
                "scheduleIds": result["schedule_ids"].as_array().cloned().unwrap_or_default(),
                "action": result["action"].as_str(),
                "target": result["target"].clone(),
                "commandResult": result["command_result"].clone(),
            })
        })
        .collect::<Vec<_>>();

    let knowledge_fact_rows = knowledge_facts
        .into_iter()
        .map(|fact| {
            serde_json::json!({
                "id": fact.id,
                "scope": fact.scope,
                "scopeRef": fact.scope_ref,
                "kind": fact.kind,
                "statement": fact.statement,
                "confidence": fact.confidence,
                "tags": fact.tags,
                "observedAt": fact.observed_at,
            })
        })
        .collect::<Vec<_>>();

    Ok(serde_json::json!({
        "team": {
            "id": team["id"].as_str().unwrap_or(""),
            "slug": team["slug"].as_str().unwrap_or(""),
            "name": team["name"].as_str().unwrap_or(""),
            "mission": team["mission"].as_str().unwrap_or(""),
            "ownership": team["ownership"].as_str().unwrap_or(""),
            "businessPriority": team["business_priority"].as_i64().unwrap_or(0),
        },
        "projects": project_rows,
        "schedules": schedule_rows,
        "placements": placement_rows,
        "hosts": host_rows,
        "daemonStatuses": status_rows,
        "reconcilePreview": {
            "evaluatedAt": reconcile_value["evaluated_at"].as_str().unwrap_or(""),
            "apply": reconcile_value["apply"].as_bool().unwrap_or(false),
            "teamId": reconcile_value["team_id"].as_str(),
            "results": reconcile_rows,
        },
        "auditEvents": audit_rows,
        "knowledgeDocuments": knowledge_document_rows,
        "knowledgeFacts": knowledge_fact_rows,
    }))
}

fn preset_windows(policy_kind: &str) -> Vec<String> {
    match policy_kind {
        "business_hours" => ["0,9,17", "1,9,17", "2,9,17", "3,9,17", "4,9,17"]
            .into_iter()
            .map(String::from)
            .collect(),
        "nightly" => vec!["0,22,6".to_string()],
        _ => Vec::new(),
    }
}

#[tauri::command]
async fn save_team_schedule(
    team_id: String,
    policy_kind: String,
    timezone: String,
    enabled: bool,
) -> Result<serde_json::Value, String> {
    let schedules_value =
        run_fleet_json_cmd_str(&["schedule-list", "--team-id", &team_id], 10).await?;
    let schedules: Vec<FleetScheduleRecord> =
        serde_json::from_value(schedules_value).map_err(|error| error.to_string())?;
    let windows = preset_windows(&policy_kind);
    let existing = schedules.first().cloned();

    let mut args = if let Some(schedule) = existing {
        vec![
            "schedule-update".to_string(),
            "--id".to_string(),
            schedule.id,
            "--policy-kind".to_string(),
            policy_kind,
            "--timezone".to_string(),
            timezone,
            "--enabled".to_string(),
            enabled.to_string(),
        ]
    } else {
        vec![
            "schedule-create".to_string(),
            "--team-id".to_string(),
            team_id.clone(),
            "--policy-kind".to_string(),
            policy_kind,
            "--timezone".to_string(),
            timezone,
            "--enabled".to_string(),
            enabled.to_string(),
        ]
    };

    for window in windows {
        args.push("--window".to_string());
        args.push(window);
    }

    let schedule = run_fleet_json_cmd(&args, 10).await?;
    let reconcile =
        run_fleet_json_cmd_str(&["daemon-reconcile", "--team-id", &team_id], 10).await?;

    Ok(serde_json::json!({
        "teamId": team_id,
        "schedule": schedule,
        "reconcilePreview": reconcile,
    }))
}

#[tauri::command]
async fn reconcile_team(team_id: String, apply: bool) -> Result<serde_json::Value, String> {
    let mut args = vec![
        "daemon-reconcile".to_string(),
        "--team-id".to_string(),
        team_id.clone(),
    ];
    if apply {
        args.push("--apply".to_string());
    }

    let reconcile = run_fleet_json_cmd(&args, 20).await?;
    let statuses =
        run_fleet_json_cmd_str(&["daemon-status", "--refresh", "--team-id", &team_id], 20).await?;

    Ok(serde_json::json!({
        "teamId": team_id,
        "reconcile": reconcile,
        "statuses": statuses,
    }))
}

#[tauri::command]
async fn set_team_host(
    team_id: String,
    host_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let projects_value = run_fleet_json_cmd_str(&["project-list"], 15).await?;
    let projects: Vec<FleetManagedProjectRecord> =
        serde_json::from_value(projects_value).map_err(|error| error.to_string())?;
    let relevant_projects = projects
        .into_iter()
        .filter(|project| project.team_id == team_id)
        .collect::<Vec<_>>();

    let mut results = Vec::new();
    for project in relevant_projects {
        let args = if let Some(value) = host_id.as_ref() {
            vec![
                "project-host-assign".to_string(),
                "--project-id".to_string(),
                project.id.clone(),
                "--host-id".to_string(),
                value.clone(),
                "--assignment-source".to_string(),
                "dashboard".to_string(),
            ]
        } else {
            vec![
                "project-host-clear".to_string(),
                "--project-id".to_string(),
                project.id.clone(),
            ]
        };
        results.push(run_fleet_json_cmd(&args, 10).await?);
    }

    Ok(serde_json::json!({
        "teamId": team_id,
        "hostId": host_id,
        "updatedProjects": results.len(),
        "results": results,
    }))
}

#[tauri::command]
async fn create_team_knowledge_note(
    team_id: String,
    title: String,
    summary: String,
    body: String,
) -> Result<serde_json::Value, String> {
    let args = vec![
        "knowledge-document-create".to_string(),
        "--scope".to_string(),
        "team".to_string(),
        "--scope-ref".to_string(),
        team_id.clone(),
        "--kind".to_string(),
        "policy_note".to_string(),
        "--title".to_string(),
        title,
        "--summary".to_string(),
        summary,
        "--body".to_string(),
        body,
        "--source-kind".to_string(),
        "manual_note".to_string(),
        "--tag".to_string(),
        "dashboard".to_string(),
    ];

    let document = run_fleet_json_cmd(&args, 10).await?;
    Ok(serde_json::json!({
        "teamId": team_id,
        "document": document,
    }))
}

#[tauri::command]
async fn set_team_enabled(team_id: String, enabled: bool) -> Result<serde_json::Value, String> {
    let projects_value = run_fleet_json_cmd_str(&["project-list"], 15).await?;
    let projects: Vec<FleetManagedProjectRecord> =
        serde_json::from_value(projects_value).map_err(|error| error.to_string())?;
    let relevant_projects = projects
        .into_iter()
        .filter(|project| project.team_id == team_id)
        .collect::<Vec<_>>();

    let mut updated = Vec::new();
    for project in relevant_projects {
        let args = vec![
            "project-update".to_string(),
            "--id".to_string(),
            project.id,
            "--enabled".to_string(),
            enabled.to_string(),
        ];
        updated.push(run_fleet_json_cmd(&args, 10).await?);
    }

    Ok(serde_json::json!({
        "teamId": team_id,
        "enabled": enabled,
        "updatedProjects": updated.len(),
        "projects": updated,
    }))
}

#[tauri::command]
async fn run_team_daemon_action(
    team_id: String,
    action: String,
) -> Result<serde_json::Value, String> {
    let allowed = ["start", "stop", "pause", "resume"];
    if !allowed.contains(&action.as_str()) {
        return Err(format!("unsupported team action: {action}"));
    }

    let projects_value = run_fleet_json_cmd_str(&["project-list"], 15).await?;
    let projects: Vec<FleetManagedProjectRecord> =
        serde_json::from_value(projects_value).map_err(|error| error.to_string())?;
    let relevant_projects = projects
        .into_iter()
        .filter(|project| {
            project.team_id == team_id
                && (matches!(action.as_str(), "stop" | "pause") || project.enabled)
        })
        .collect::<Vec<_>>();

    let mut results = Vec::new();
    for project in relevant_projects {
        match run_fleet_project_json_cmd(
            &project.ao_project_root,
            &["daemon".to_string(), action.clone()],
            20,
        )
        .await
        {
            Ok(value) => results.push(serde_json::json!({
                "projectId": project.id,
                "slug": project.slug,
                "root": project.ao_project_root,
                "ok": true,
                "result": value,
            })),
            Err(error) => results.push(serde_json::json!({
                "projectId": project.id,
                "slug": project.slug,
                "root": project.ao_project_root,
                "ok": false,
                "error": error,
            })),
        }
    }

    let statuses =
        run_fleet_json_cmd_str(&["daemon-status", "--refresh", "--team-id", &team_id], 20).await?;

    Ok(serde_json::json!({
        "teamId": team_id,
        "action": action,
        "results": results,
        "statuses": statuses,
    }))
}

#[tauri::command]
async fn start_filtered_stream(
    app: tauri::AppHandle,
    streams: tauri::State<'_, StreamRegistry>,
    project_root: String,
    workflow: Option<String>,
    run: Option<String>,
    cat: Option<String>,
    level: Option<String>,
) -> Result<String, String> {
    let stream_id = streams.next_filtered_id.fetch_add(1, Ordering::Relaxed);
    let project_name = project_name_from_root(&project_root);
    let channel_id = format!("filtered-stream:{project_name}:{stream_id}");
    let mut args = vec![
        "project-events".to_string(),
        "--project-root".to_string(),
        project_root.clone(),
        "--tail".to_string(),
        FILTERED_STREAM_TAIL_LINES.to_string(),
        "--follow".to_string(),
    ];
    if let Some(value) = workflow.as_deref().filter(|value| !value.is_empty()) {
        args.push("--workflow".to_string());
        args.push(value.to_string());
    } else if let Some(value) = run.as_deref().filter(|value| !value.is_empty()) {
        args.push("--run".to_string());
        args.push(value.to_string());
    }
    if let Some(value) = cat.as_deref().filter(|value| !value.is_empty()) {
        args.push("--cat".to_string());
        args.push(value.to_string());
    }
    if let Some(value) = level
        .as_deref()
        .filter(|value| !value.is_empty() && *value != "all")
    {
        args.push("--level".to_string());
        args.push(value.to_string());
    }
    let ch = channel_id.clone();
    let filtered_streams = streams.filtered_streams.clone();
    tokio::spawn(async move {
        let mut command = match build_fleet_command(&args) {
            Ok(command) => command,
            Err(error) => {
                eprintln!("filtered stream setup error for {project_name}: {error}");
                return;
            }
        };
        command
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);

        let child = match command.spawn() {
            Ok(c) => c,
            Err(e) => {
                eprintln!("filtered stream error for {project_name}: {e}");
                return;
            }
        };

        let child = Arc::new(AsyncMutex::new(child));

        {
            let mut entries = match filtered_streams.lock() {
                Ok(entries) => entries,
                Err(_) => return,
            };
            entries.insert(ch.clone(), child.clone());
        }

        let stdout = {
            let mut guard = child.lock().await;
            guard.stdout.take()
        };

        if let Some(stdout) = stdout {
            let reader = BufReader::new(stdout);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Ok(event) = serde_json::from_str::<StreamEvent>(&line) {
                    let _ = app.emit(&ch, &event);
                }
            }
        }

        if let Ok(mut entries) = filtered_streams.lock() {
            entries.remove(&ch);
        }
    });

    Ok(channel_id)
}

#[tauri::command]
async fn stop_filtered_stream(
    streams: tauri::State<'_, StreamRegistry>,
    channel_id: String,
) -> Result<(), String> {
    let child = {
        let mut entries = streams
            .filtered_streams
            .lock()
            .map_err(|_| "filtered stream registry poisoned".to_string())?;
        entries.remove(&channel_id)
    };

    let Some(child) = child else {
        return Ok(());
    };

    let mut guard = child.lock().await;
    guard.kill().await.map_err(|e| e.to_string())?;
    let _ = guard.wait().await;
    Ok(())
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AgentConfig {
    pub name: String,
    pub model: String,
    pub tool: String,
    pub system_prompt: Option<String>,
    pub mcp_servers: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PhaseConfig {
    pub id: String,
    pub mode: String,
    pub agent: Option<String>,
    pub directive: Option<String>,
    pub command: Option<String>,
    pub command_args: Vec<String>,
    pub timeout_secs: Option<i64>,
    pub cwd_mode: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WorkflowConfig {
    pub id: String,
    pub name: Option<String>,
    pub description: Option<String>,
    pub phases: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ScheduleConfig {
    pub id: String,
    pub cron: String,
    pub workflow_ref: String,
    pub enabled: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ProjectConfig {
    pub project: String,
    pub root: String,
    pub agents: Vec<AgentConfig>,
    pub phases: Vec<PhaseConfig>,
    pub workflows: Vec<WorkflowConfig>,
    pub schedules: Vec<ScheduleConfig>,
}

#[tauri::command]
async fn get_project_config(project_root: String) -> Result<ProjectConfig, String> {
    serde_json::from_value(run_fleet_project_config_cmd(&project_root).await?)
        .map_err(|error| error.to_string())
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TaskInfo {
    pub id: String,
    pub title: String,
    pub status: String,
    pub priority: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TaskCreatePayload {
    pub title: String,
    pub description: Option<String>,
    pub task_type: Option<String>,
    pub priority: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TaskUpdatePayload {
    pub id: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub priority: Option<String>,
    pub status: Option<String>,
    pub assignee: Option<String>,
}

#[tauri::command]
async fn get_task_list(
    project_root: String,
    prioritized: Option<bool>,
    status: Option<String>,
    priority: Option<String>,
    search: Option<String>,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<Vec<TaskInfo>, String> {
    let subcommand = if prioritized.unwrap_or(false) {
        "prioritized"
    } else {
        "list"
    };
    let mut args = vec!["task".to_string(), subcommand.to_string()];
    if let Some(value) = status.filter(|value| !value.trim().is_empty()) {
        args.push("--status".to_string());
        args.push(value);
    }
    if let Some(value) = priority.filter(|value| !value.trim().is_empty()) {
        args.push("--priority".to_string());
        args.push(value);
    }
    if let Some(value) = search.filter(|value| !value.trim().is_empty()) {
        args.push("--search".to_string());
        args.push(value);
    }
    if let Some(value) = limit {
        args.push("--limit".to_string());
        args.push(value.to_string());
    }
    if let Some(value) = offset {
        args.push("--offset".to_string());
        args.push(value.to_string());
    }
    let data = run_fleet_project_json_cmd(&project_root, &args, 15).await?;
    let tasks = data.as_array().cloned().unwrap_or_default();
    Ok(tasks
        .iter()
        .map(|t| TaskInfo {
            id: t["id"].as_str().unwrap_or("").to_string(),
            title: t["title"].as_str().unwrap_or("").to_string(),
            status: t["status"].as_str().unwrap_or("").to_string(),
            priority: t["priority"].as_str().unwrap_or("medium").to_string(),
        })
        .collect())
}

#[tauri::command]
async fn list_tasks_full(
    project_root: String,
    prioritized: Option<bool>,
) -> Result<serde_json::Value, String> {
    let subcommand = if prioritized.unwrap_or(false) {
        "prioritized"
    } else {
        "list"
    };
    run_fleet_project_json_cmd(
        &project_root,
        &["task".to_string(), subcommand.to_string()],
        15,
    )
    .await
}

#[tauri::command]
async fn get_task_detail(project_root: String, id: String) -> Result<serde_json::Value, String> {
    run_fleet_project_json_cmd(
        &project_root,
        &[
            "task".to_string(),
            "get".to_string(),
            "--id".to_string(),
            id,
        ],
        15,
    )
    .await
}

#[tauri::command]
async fn get_task_stats(project_root: String) -> Result<serde_json::Value, String> {
    run_fleet_project_json_cmd(
        &project_root,
        &["task".to_string(), "stats".to_string()],
        15,
    )
    .await
}

#[tauri::command]
async fn get_next_task(project_root: String) -> Result<serde_json::Value, String> {
    run_fleet_project_json_cmd(&project_root, &["task".to_string(), "next".to_string()], 15).await
}

#[tauri::command]
async fn create_task(
    project_root: String,
    payload: TaskCreatePayload,
) -> Result<serde_json::Value, String> {
    let mut args = vec![
        "task".to_string(),
        "create".to_string(),
        "--title".to_string(),
        payload.title,
    ];
    if let Some(description) = payload.description.filter(|value| !value.trim().is_empty()) {
        args.push("--description".to_string());
        args.push(description);
    }
    if let Some(task_type) = payload.task_type.filter(|value| !value.trim().is_empty()) {
        args.push("--task-type".to_string());
        args.push(task_type);
    }
    if let Some(priority) = payload.priority.filter(|value| !value.trim().is_empty()) {
        args.push("--priority".to_string());
        args.push(priority);
    }
    run_fleet_project_json_cmd(&project_root, &args, 15).await
}

#[tauri::command]
async fn update_task_detail(
    project_root: String,
    payload: TaskUpdatePayload,
) -> Result<serde_json::Value, String> {
    let mut args = vec![
        "task".to_string(),
        "update".to_string(),
        "--id".to_string(),
        payload.id,
    ];
    if let Some(title) = payload.title.filter(|value| !value.trim().is_empty()) {
        args.push("--title".to_string());
        args.push(title);
    }
    if let Some(description) = payload.description {
        args.push("--description".to_string());
        args.push(description);
    }
    if let Some(priority) = payload.priority.filter(|value| !value.trim().is_empty()) {
        args.push("--priority".to_string());
        args.push(priority);
    }
    if let Some(status) = payload.status.filter(|value| !value.trim().is_empty()) {
        args.push("--status".to_string());
        args.push(status);
    }
    if let Some(assignee) = payload.assignee.filter(|value| !value.trim().is_empty()) {
        args.push("--assignee".to_string());
        args.push(assignee);
    }
    run_fleet_project_json_cmd(&project_root, &args, 15).await
}

#[tauri::command]
async fn set_task_status(
    project_root: String,
    id: String,
    status: String,
) -> Result<serde_json::Value, String> {
    run_fleet_project_json_cmd(
        &project_root,
        &[
            "task".to_string(),
            "status".to_string(),
            "--id".to_string(),
            id,
            "--status".to_string(),
            status,
        ],
        15,
    )
    .await
}

#[tauri::command]
async fn assign_task(
    project_root: String,
    id: String,
    assignee: String,
    assignee_type: Option<String>,
    agent_role: Option<String>,
    model: Option<String>,
) -> Result<serde_json::Value, String> {
    let mut args = vec![
        "task".to_string(),
        "assign".to_string(),
        "--id".to_string(),
        id,
        "--assignee".to_string(),
        assignee,
    ];
    if let Some(value) = assignee_type.filter(|value| !value.trim().is_empty()) {
        args.push("--type".to_string());
        args.push(value);
    }
    if let Some(value) = agent_role.filter(|value| !value.trim().is_empty()) {
        args.push("--agent-role".to_string());
        args.push(value);
    }
    if let Some(value) = model.filter(|value| !value.trim().is_empty()) {
        args.push("--model".to_string());
        args.push(value);
    }
    run_fleet_project_json_cmd(&project_root, &args, 15).await
}

#[tauri::command]
async fn set_task_priority(
    project_root: String,
    id: String,
    priority: String,
) -> Result<serde_json::Value, String> {
    run_fleet_project_json_cmd(
        &project_root,
        &[
            "task".to_string(),
            "set-priority".to_string(),
            "--id".to_string(),
            id,
            "--priority".to_string(),
            priority,
        ],
        15,
    )
    .await
}

#[tauri::command]
async fn set_task_deadline(
    project_root: String,
    id: String,
    deadline: Option<String>,
) -> Result<serde_json::Value, String> {
    let mut args = vec![
        "task".to_string(),
        "set-deadline".to_string(),
        "--id".to_string(),
        id,
    ];
    if let Some(value) = deadline.filter(|value| !value.trim().is_empty()) {
        args.push("--deadline".to_string());
        args.push(value);
    }
    run_fleet_project_json_cmd(&project_root, &args, 15).await
}

#[tauri::command]
async fn add_task_checklist_item(
    project_root: String,
    id: String,
    description: String,
) -> Result<serde_json::Value, String> {
    run_fleet_project_json_cmd(
        &project_root,
        &[
            "task".to_string(),
            "checklist-add".to_string(),
            "--id".to_string(),
            id,
            "--description".to_string(),
            description,
        ],
        15,
    )
    .await
}

#[tauri::command]
async fn update_task_checklist_item(
    project_root: String,
    id: String,
    item_id: String,
    completed: bool,
) -> Result<serde_json::Value, String> {
    run_fleet_project_json_cmd(
        &project_root,
        &[
            "task".to_string(),
            "checklist-update".to_string(),
            "--id".to_string(),
            id,
            "--item-id".to_string(),
            item_id,
            "--completed".to_string(),
            completed.to_string(),
        ],
        15,
    )
    .await
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CommitInfo {
    pub hash: String,
    pub message: String,
    pub date: String,
}

#[tauri::command]
async fn get_recent_commits(project_root: String) -> Result<Vec<CommitInfo>, String> {
    let output = Command::new("git")
        .args([
            "log",
            "--oneline",
            "--no-merges",
            "-30",
            "--format=%h\t%s\t%ci",
        ])
        .current_dir(&project_root)
        .output()
        .await
        .map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(stdout
        .lines()
        .filter_map(|line| {
            let parts: Vec<&str> = line.splitn(3, '\t').collect();
            if parts.len() >= 2 {
                Some(CommitInfo {
                    hash: parts[0].to_string(),
                    message: parts[1].to_string(),
                    date: parts.get(2).unwrap_or(&"").to_string(),
                })
            } else {
                None
            }
        })
        .collect())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Arc::new(AoSessionStore::default()))
        .manage(AoHelpCache::default())
        .manage(StreamRegistry::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            discover_projects,
            get_global_ao_info,
            get_health,
            get_all_health,
            start_stream,
            get_recent_events,
            get_filtered_events,
            get_workflows,
            get_task_summary,
            get_fleet_data,
            get_team_snapshot,
            set_team_enabled,
            run_team_daemon_action,
            save_team_schedule,
            reconcile_team,
            set_team_host,
            create_team_knowledge_note,
            start_filtered_stream,
            stop_filtered_stream,
            get_project_config,
            get_task_list,
            list_tasks_full,
            get_task_detail,
            get_task_stats,
            get_next_task,
            create_task,
            update_task_detail,
            set_task_status,
            assign_task,
            set_task_priority,
            set_task_deadline,
            add_task_checklist_item,
            update_task_checklist_item,
            get_recent_commits,
            get_ao_help,
            start_ao_session,
            stop_ao_session,
            write_ao_session_stdin,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
