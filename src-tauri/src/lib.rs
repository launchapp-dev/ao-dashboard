use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Stdio;
use tauri::Emitter;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::time;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Project {
    pub name: String,
    pub root: String,
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
    pub ts: String,
    pub level: String,
    pub cat: String,
    pub msg: String,
    pub subject_id: Option<String>,
    pub phase_id: Option<String>,
    pub task_id: Option<String>,
    pub workflow_ref: Option<String>,
    pub model: Option<String>,
    pub tool: Option<String>,
    pub schedule_id: Option<String>,
    pub meta: Option<serde_json::Value>,
}

fn ao_binary() -> String {
    let home = dirs::home_dir().unwrap_or_default();
    let local_bin = home.join(".local/bin/ao");
    if local_bin.exists() {
        return local_bin.to_string_lossy().to_string();
    }
    "ao".to_string()
}

#[tauri::command]
async fn discover_projects() -> Result<Vec<Project>, String> {
    let home = dirs::home_dir().ok_or("no home dir")?;
    let ao_dir = home.join(".ao");
    let mut projects = Vec::new();
    let mut seen_roots = std::collections::HashSet::new();

    if let Ok(entries) = std::fs::read_dir(&ao_dir) {
        for entry in entries.flatten() {
            let dir_name = entry.file_name().to_string_lossy().to_string();
            if dir_name.starts_with("tmp")
                || dir_name.starts_with("ao-subject")
                || dir_name.starts_with("agent-")
                || dir_name.starts_with("ao-test-")
                || dir_name.ends_with(".db")
            {
                continue;
            }

            let dir = entry.path();
            if !dir.is_dir() {
                continue;
            }

            let root = if let Ok(target) = std::fs::read_link(dir.join("project-root")) {
                target.to_string_lossy().to_string()
            } else if let Ok(content) = std::fs::read_to_string(dir.join(".project-root")) {
                content.trim().to_string()
            } else {
                continue;
            };

            if !PathBuf::from(&root).exists() || !seen_roots.insert(root.clone()) {
                continue;
            }

            let display_name = PathBuf::from(&root)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| dir_name.clone());

            projects.push(Project {
                name: display_name,
                root,
            });
        }
    }

    projects.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(projects)
}

async fn run_ao_cmd(args: &[&str], timeout_secs: u64) -> Result<String, String> {
    let child = Command::new(ao_binary())
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;

    match tokio::time::timeout(
        std::time::Duration::from_secs(timeout_secs),
        child.wait_with_output(),
    )
    .await
    {
        Ok(Ok(output)) => Ok(String::from_utf8_lossy(&output.stdout).to_string()),
        Ok(Err(e)) => Err(e.to_string()),
        Err(_) => Err("timeout".to_string()),
    }
}

fn parse_health(project_root: &str, stdout: &str) -> DaemonHealth {
    let name = PathBuf::from(project_root)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    let val: serde_json::Value = serde_json::from_str(stdout).unwrap_or_default();

    DaemonHealth {
        project: name,
        root: project_root.to_string(),
        status: val["status"].as_str().unwrap_or("unknown").to_string(),
        active_agents: val["active_agents"].as_i64().unwrap_or(0),
        pool_size: val["pool_size"].as_i64().unwrap_or(5),
        queued_tasks: val["queued_tasks"].as_i64().unwrap_or(0),
        daemon_pid: val["daemon_pid"].as_i64(),
        pool_utilization_percent: val["pool_utilization_percent"].as_f64().unwrap_or(0.0),
        healthy: val["healthy"].as_bool().unwrap_or(false),
    }
}

#[tauri::command]
async fn get_health(project_root: String) -> Result<DaemonHealth, String> {
    let stdout = run_ao_cmd(
        &["daemon", "health", "--project-root", &project_root],
        5,
    )
    .await?;
    Ok(parse_health(&project_root, &stdout))
}

#[tauri::command]
async fn get_all_health(projects: Vec<Project>) -> Result<Vec<DaemonHealth>, String> {
    let mut handles = Vec::new();

    for project in projects {
        let root = project.root.clone();
        let name = project.name.clone();
        handles.push(tokio::spawn(async move {
            match run_ao_cmd(&["daemon", "health", "--project-root", &root], 30).await {
                Ok(stdout) => {
                    let mut h = parse_health(&root, &stdout);
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
async fn start_stream(app: tauri::AppHandle, project_root: String) -> Result<(), String> {
    let project_name = PathBuf::from(&project_root)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    let ao = ao_binary();
    tokio::spawn(async move {
        let mut child = match Command::new(&ao)
            .args([
                "daemon",
                "stream",
                "--project-root",
                &project_root,
                "--json",
                "--tail",
                "50",
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                eprintln!("stream spawn error for {project_name}: {e}");
                return;
            }
        };

        if let Some(stdout) = child.stdout.take() {
            let reader = BufReader::new(stdout);
            let mut lines = reader.lines();

            while let Ok(Some(line)) = lines.next_line().await {
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(&line) {
                    let event = parse_stream_event(&project_name, &val);
                    let _ = app.emit("stream-event", &event);
                }
            }
        }
    });

    Ok(())
}

#[tauri::command]
async fn get_recent_events(project_root: String) -> Result<Vec<StreamEvent>, String> {
    let project_name = PathBuf::from(&project_root)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    let output = Command::new(ao_binary())
        .args([
            "daemon",
            "stream",
            "--project-root",
            &project_root,
            "--json",
            "--tail",
            "50",
            "--no-follow",
        ])
        .output()
        .await
        .map_err(|e| e.to_string())?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut events = Vec::new();

    for line in stdout.lines() {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(line) {
            events.push(parse_stream_event(&project_name, &val));
        }
    }

    Ok(events)
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
    let project_name = PathBuf::from(&project_root)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    let stdout = run_ao_cmd(&["workflow", "list", "--project-root", &project_root], 5).await?;
    let val: Vec<serde_json::Value> =
        serde_json::from_str(&stdout).unwrap_or_default();

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
    let project_name = PathBuf::from(&project_root)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    let stdout = run_ao_cmd(&["task", "list", "--project-root", &project_root], 5).await?;
    let tasks: Vec<serde_json::Value> =
        serde_json::from_str(&stdout).unwrap_or_default();

    let mut summary = TaskSummary {
        project: project_name,
        backlog: 0, ready: 0, blocked: 0, done: 0,
        cancelled: 0, on_hold: 0, in_progress: 0, total: tasks.len() as i64,
    };

    for t in &tasks {
        match t["status"].as_str().unwrap_or("") {
            "backlog" => summary.backlog += 1,
            "ready" => summary.ready += 1,
            "blocked" => summary.blocked += 1,
            "done" => summary.done += 1,
            "cancelled" => summary.cancelled += 1,
            "on-hold" | "on_hold" => summary.on_hold += 1,
            "in-progress" | "in_progress" => summary.in_progress += 1,
            _ => {}
        }
    }

    Ok(summary)
}

#[tauri::command]
async fn get_fleet_data() -> Result<serde_json::Value, String> {
    let projects = discover_projects().await?;
    let mut handles = Vec::new();

    for project in projects {
        let name = project.name.clone();
        let root = project.root.clone();
        handles.push(tokio::spawn(async move {
            let r1 = root.clone();
            let r2 = root.clone();
            let r3 = root.clone();

            let (health, workflows, tasks) = tokio::join!(
                async { run_ao_cmd(&["daemon", "health", "--project-root", &r1], 5).await.map(|s| parse_health(&r1, &s)).ok() },
                async { get_workflows(r2).await.unwrap_or_default() },
                async { get_task_summary(r3).await.ok() },
            );

            serde_json::json!({
                "name": name,
                "root": root,
                "health": health,
                "workflows": workflows,
                "tasks": tasks,
            })
        }));
    }

    let mut fleet = Vec::new();
    for handle in handles {
        if let Ok(val) = handle.await {
            fleet.push(val);
        }
    }

    Ok(serde_json::json!({ "projects": fleet }))
}

fn parse_stream_event(project_name: &str, val: &serde_json::Value) -> StreamEvent {
    let wf_ref = val["meta"]["workflow_ref"]
        .as_str()
        .or(val["workflow_ref"].as_str())
        .map(String::from);
    StreamEvent {
        project: project_name.to_string(),
        ts: val["ts"].as_str().unwrap_or("").to_string(),
        level: val["level"].as_str().unwrap_or("info").to_string(),
        cat: val["cat"].as_str().unwrap_or("").to_string(),
        msg: val["msg"].as_str().unwrap_or("").to_string(),
        subject_id: val["subject_id"].as_str().map(String::from),
        phase_id: val["phase_id"].as_str().map(String::from),
        task_id: val["task_id"].as_str().map(String::from),
        workflow_ref: wf_ref,
        model: val["model"].as_str().map(String::from),
        tool: val["tool"].as_str().map(String::from),
        schedule_id: val["schedule_id"].as_str().map(String::from),
        meta: val.get("meta").cloned(),
    }
}

#[tauri::command]
async fn start_filtered_stream(
    app: tauri::AppHandle,
    project_root: String,
    workflow: Option<String>,
    run: Option<String>,
    cat: Option<String>,
    level: Option<String>,
) -> Result<String, String> {
    let project_name = PathBuf::from(&project_root)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    let mut args = vec![
        "daemon".to_string(),
        "stream".to_string(),
        "--project-root".to_string(),
        project_root,
        "--json".to_string(),
        "--tail".to_string(),
        "100".to_string(),
    ];

    let channel_id = if let Some(ref wf) = workflow {
        args.push("--workflow".to_string());
        args.push(wf.clone());
        format!("filtered-stream:{project_name}:wf:{wf}")
    } else if let Some(ref r) = run {
        args.push("--run".to_string());
        args.push(r.clone());
        format!("filtered-stream:{project_name}:run:{r}")
    } else {
        format!("filtered-stream:{project_name}:all")
    };

    if let Some(ref c) = cat {
        args.push("--cat".to_string());
        args.push(c.clone());
    }
    if let Some(ref l) = level {
        args.push("--level".to_string());
        args.push(l.clone());
    }

    let ao = ao_binary();
    let ch = channel_id.clone();
    tokio::spawn(async move {
        let mut child = match Command::new(&ao)
            .args(args.iter().map(|s| s.as_str()).collect::<Vec<_>>())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                eprintln!("filtered stream error for {project_name}: {e}");
                return;
            }
        };

        if let Some(stdout) = child.stdout.take() {
            let reader = BufReader::new(stdout);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(&line) {
                    let event = parse_stream_event(&project_name, &val);
                    let _ = app.emit(&ch, &event);
                }
            }
        }
    });

    Ok(channel_id)
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AgentConfig {
    pub name: String,
    pub model: String,
    pub tool: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PhaseConfig {
    pub id: String,
    pub mode: String,
    pub agent: Option<String>,
    pub command: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WorkflowConfig {
    pub id: String,
    pub phases: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ScheduleConfig {
    pub id: String,
    pub cron: String,
    pub workflow_ref: String,
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
    let project_name = PathBuf::from(&project_root)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    let wf_dir = PathBuf::from(&project_root).join(".ao").join("workflows");
    let mut merged: serde_json::Map<String, serde_json::Value> = serde_json::Map::new();

    if let Ok(entries) = std::fs::read_dir(&wf_dir) {
        let mut files: Vec<_> = entries.flatten().collect();
        files.sort_by_key(|e| e.file_name());
        for entry in files {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("yaml") {
                continue;
            }
            if let Ok(content) = std::fs::read_to_string(&path) {
                if let Ok(val) = serde_yaml::from_str::<serde_json::Value>(&content) {
                    if let Some(obj) = val.as_object() {
                        for (k, v) in obj {
                            match (merged.get(k), v) {
                                (Some(serde_json::Value::Object(existing)), serde_json::Value::Object(new_obj)) => {
                                    let mut m = existing.clone();
                                    for (mk, mv) in new_obj {
                                        m.insert(mk.clone(), mv.clone());
                                    }
                                    merged.insert(k.clone(), serde_json::Value::Object(m));
                                }
                                (Some(serde_json::Value::Array(existing)), serde_json::Value::Array(new_arr)) => {
                                    let mut m = existing.clone();
                                    m.extend(new_arr.iter().cloned());
                                    merged.insert(k.clone(), serde_json::Value::Array(m));
                                }
                                _ => {
                                    merged.insert(k.clone(), v.clone());
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    let agents = if let Some(serde_json::Value::Object(agents_map)) = merged.get("agents") {
        agents_map.iter().map(|(name, val)| {
            AgentConfig {
                name: name.clone(),
                model: val["model"].as_str().unwrap_or("default").to_string(),
                tool: val["tool"].as_str().unwrap_or("claude").to_string(),
            }
        }).collect()
    } else {
        vec![]
    };

    let phases = if let Some(serde_json::Value::Object(phases_map)) = merged.get("phases") {
        phases_map.iter().map(|(id, val)| {
            let cmd = val["command"]["program"].as_str().map(String::from);
            PhaseConfig {
                id: id.clone(),
                mode: val["mode"].as_str().unwrap_or("agent").to_string(),
                agent: val["agent"].as_str().map(String::from),
                command: cmd,
            }
        }).collect()
    } else {
        vec![]
    };

    let mut seen_wf = std::collections::HashSet::new();
    let workflows = if let Some(serde_json::Value::Array(wf_arr)) = merged.get("workflows") {
        wf_arr.iter().filter_map(|w| {
            let id = w["id"].as_str()?.to_string();
            if !seen_wf.insert(id.clone()) { return None; }
            let phase_list = w["phases"].as_array().map(|arr| {
                arr.iter().filter_map(|p| {
                    p.as_str().map(String::from)
                        .or_else(|| p["phase_ref"].as_str().map(String::from))
                }).collect()
            }).unwrap_or_default();
            Some(WorkflowConfig { id, phases: phase_list })
        }).collect()
    } else {
        vec![]
    };

    let mut seen_sched = std::collections::HashSet::new();
    let schedules = if let Some(serde_json::Value::Array(sched_arr)) = merged.get("schedules") {
        sched_arr.iter().filter_map(|s| {
            let id = s["id"].as_str()?.to_string();
            if !seen_sched.insert(id.clone()) { return None; }
            Some(ScheduleConfig {
                id,
                cron: s["cron"].as_str().unwrap_or("").to_string(),
                workflow_ref: s["workflow_ref"].as_str().unwrap_or("").to_string(),
            })
        }).collect()
    } else {
        vec![]
    };

    Ok(ProjectConfig {
        project: project_name,
        root: project_root,
        agents,
        phases,
        workflows,
        schedules,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            discover_projects,
            get_health,
            get_all_health,
            start_stream,
            get_recent_events,
            get_workflows,
            get_task_summary,
            get_fleet_data,
            start_filtered_stream,
            get_project_config,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
