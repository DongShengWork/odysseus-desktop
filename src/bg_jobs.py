"""agent `bash` 工具的后台作业执行。

长时间运行的命令（安装、ffmpeg、模型下载）不应阻塞聊天流 —
多分钟保持的 SSE 连接很脆弱（模型提前停止、超时、标签页挂起）。
相反，我们以**分离**方式启动它们，让始终运行的监视器在它们完成时
重新调用 agent（"auto-continue"）。

设计目标：
  * 重启安全：状态从磁盘上的退出代码文件推导，而非实时 PID，
    因此 uvicorn 重启不会丢失作业或其结果。
  * 幂等跟进：作业保持 {done, followed_up: False} 直到 agent
    确实被重新调用，因此完成结果不会悄无声息地"什么都不做" —
    监视器会在下一个周期重试。
  * 边界限制：硬性最大运行时间将失控作业标记为失败，并仍会触发
    跟进（"超时"），因此你始终会收到通知。

此模块仅负责启动 + 状态管理。监视器 / agent 重新调用由调用者负责
（因此此模块保持轻量导入和可单元测试）。
"""

from __future__ import annotations

import json
import os
import shlex
import subprocess
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

from core.atomic_io import atomic_write_json
from core.platform_compat import (
    detached_popen_kwargs,
    find_bash,
    git_bash_path,
    kill_process_tree,
    pid_alive,
)

from src.constants import BG_JOBS_DIR, BG_JOBS_FILE

_JOBS_DIR = Path(BG_JOBS_DIR)
_STORE = Path(BG_JOBS_FILE)

# 运行时间超过此值的作业被视为卡住并被回收（agent
# 仍会收到"超时"跟进，因此不会有任何东西永远挂起）。
DEFAULT_MAX_RUNTIME_S = 3600  # 1 小时
# 限制我们保留/反馈给模型的捕获输出量。
_MAX_OUTPUT_CHARS = 16000
# 已完成并已跟进的作业（记录及其 .sh/.cmd.sh/.log/.exit
# 文件）在被清理前保留多长时间，以防止存储和 data/bg_jobs/
# 无限增长。此时 agent 已经消费了结果。
_RETENTION_S = 3600  # 跟进后 1 小时


def _load() -> Dict[str, Dict[str, Any]]:
    try:
        if _STORE.exists():
            data = json.loads(_STORE.read_text(encoding="utf-8")) or {}
            if not isinstance(data, dict):
                return {}
            return {str(job_id): rec for job_id, rec in data.items() if isinstance(rec, dict)}
    except Exception:
        pass
    return {}


def _save(jobs: Dict[str, Dict[str, Any]]) -> None:
    atomic_write_json(str(_STORE), jobs, indent=2)


def _pid_alive(pid: Optional[int]) -> bool:
    # 委托给平台安全的探测。注意：裸 os.kill(pid, 0) 在 Windows 上不安全 —
    # CPython 将其路由到 TerminateProcess，这会杀死我们仅仅想检查的作业。
    # core.platform_compat.pid_alive 正确处理两个操作系统。
    return pid_alive(pid)


def launch(command: str, session_id: str, cwd: Optional[str] = None,
           max_runtime_s: int = DEFAULT_MAX_RUNTIME_S) -> Dict[str, Any]:
    """以分离方式启动 `command`。返回作业记录 (status='running')。

    输出 + 最终退出代码写入文件，因此状态在服务器重启后仍然存在。
    进程被放入其自己的会话 (setsid)，因此它会在启动它的请求/流结束后
    继续存在。
    """
    _JOBS_DIR.mkdir(parents=True, exist_ok=True)
    job_id = uuid.uuid4().hex[:12]
    log_path = _JOBS_DIR / f"{job_id}.log"
    exit_path = _JOBS_DIR / f"{job_id}.exit"

    # 用户命令放在它自己的脚本文件中，作为子进程 `bash` 运行。这样
    # 可以实现隔离：其中的 `exit` 只结束该子进程（因此
    # 包装器仍会记录退出代码），而且 — 与在文本中将命令
    # 包装在 `( … )` 中不同 — 包装器不会被不平衡的括号或
    # 命令中的尾随行续接符破坏。`$?` 是子进程的真实退出状态。
    bash = find_bash()
    if bash:
        # POSIX，或带 Git Bash/WSL 的 Windows。用户命令放在它自己的
        # 脚本文件中，作为子进程 `bash` 运行 — 其中的 `exit` 只结束
        # 该子进程（因此包装器仍会记录退出代码），而命令中的不等
        # 号或尾随行续接符不会破坏包装器。`$?` 是子进程的真实退出状态。
        # 路径以 POSIX（正斜杠）+ shell 引号形式发出，以便 Git Bash on Windows
        # 正确处理驱动器路径和空格。
        cmd_path = _JOBS_DIR / f"{job_id}.cmd.sh"
        cmd_path.write_text(command + "\n", encoding="utf-8")
        lp, xp, cp = (shlex.quote(git_bash_path(p)) for p in (log_path, exit_path, cmd_path))
        script_path = _JOBS_DIR / f"{job_id}.sh"
        script_path.write_text(
            f"bash {cp} > {lp} 2>&1\n"
            f"echo $? > {xp}\n",
            encoding="utf-8",
        )
        argv = [bash, str(script_path)]
    else:
        # 没有任何 bash 的 Windows：cmd.exe 包装器。命令在其
        # 自己的子 .cmd 中运行，因此 %ERRORLEVEL% 是命令的真实退出代码。
        child_path = _JOBS_DIR / f"{job_id}.child.cmd"
        child_path.write_text("@echo off\r\n" + command + "\r\n", encoding="utf-8")
        script_path = _JOBS_DIR / f"{job_id}.cmd"
        script_path.write_text(
            "@echo off\r\n"
            f'call "{child_path}" > "{log_path}" 2>&1\r\n'
            f'echo %ERRORLEVEL%> "{exit_path}"\r\n',
            encoding="utf-8",
        )
        argv = [os.environ.get("ComSpec", "cmd.exe"), "/c", str(script_path)]

    proc = subprocess.Popen(
        argv,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        stdin=subprocess.DEVNULL,
        cwd=cwd or None,
        **detached_popen_kwargs(),  # 从请求生命周期分离（setsid / DETACHED_PROCESS）
    )

    rec = {
        "id": job_id,
        "session_id": session_id,
        "command": command,
        "status": "running",       # running | done | failed
        "pid": proc.pid,
        "started_at": time.time(),
        "ended_at": None,
        "exit_code": None,
        "max_runtime_s": max_runtime_s,
        "followed_up": False,       # agent 是否已随结果重新调用？
        "log_path": str(log_path),
        "exit_path": str(exit_path),
    }
    jobs = _load()
    jobs[job_id] = rec
    _save(jobs)
    return rec


def _read_output(rec: Dict[str, Any]) -> str:
    try:
        txt = Path(rec["log_path"]).read_text(encoding="utf-8", errors="replace")
    except Exception:
        return ""
    if len(txt) > _MAX_OUTPUT_CHARS:
        # 保留头部 + 尾部 — 有趣的部分通常位于两端。
        head = txt[: _MAX_OUTPUT_CHARS // 2]
        tail = txt[-_MAX_OUTPUT_CHARS // 2:]
        txt = head + "\n…[truncated]…\n" + tail
    return txt


def _prune(jobs: Dict[str, Dict[str, Any]], now: float) -> bool:
    """丢弃已完成、已跟进且超过保留窗口的作业记录（及其磁盘文件）。会修改 `jobs`。"""
    stale = [jid for jid, rec in jobs.items()
             if rec.get("followed_up") and rec.get("ended_at")
             and (now - rec["ended_at"]) > _RETENTION_S]
    for jid in stale:
        jobs.pop(jid, None)
        for p in _JOBS_DIR.glob(f"{jid}.*"):   # .sh .cmd.sh .log .exit
            try:
                p.unlink()
            except Exception:
                pass
    return bool(stale)


def refresh() -> Dict[str, Dict[str, Any]]:
    """将每个运行中的作业与磁盘状态进行对账。标记完成/失败（包括超时）。
    幂等的 — 可以从轮询循环安全调用。返回存储。"""
    jobs = _load()
    changed = False
    now = time.time()
    for rec in jobs.values():
        if rec.get("status") != "running":
            continue
        exit_path = Path(rec.get("exit_path", ""))
        if exit_path.exists():
            try:
                code = int(exit_path.read_text(encoding="utf-8", errors="replace").strip() or "1")
            except Exception:
                code = 1
            rec["exit_code"] = code
            rec["status"] = "done" if code == 0 else "failed"
            rec["ended_at"] = now
            changed = True
        elif (now - rec.get("started_at", now)) > rec.get("max_runtime_s", DEFAULT_MAX_RUNTIME_S):
            # 失控 / 卡住 — 回收它但仍会触发跟进。
            _kill(rec.get("pid"))
            rec["status"] = "failed"
            rec["exit_code"] = -1
            rec["ended_at"] = now
            rec["timed_out"] = True
            changed = True
        elif not _pid_alive(rec.get("pid")) and not exit_path.exists():
            # 进程消失而未写入退出代码（被杀死、OOM、
            # 崩溃）。不要让它永远保持 "running" 状态。
            rec["status"] = "failed"
            rec["exit_code"] = -1
            rec["ended_at"] = now
            rec["died"] = True
            changed = True
    if _prune(jobs, now):
        changed = True
    if changed:
        _save(jobs)
    return jobs


def _kill(pid: Optional[int]) -> None:
    # 跨平台进程树拆除（POSIX killpg / Windows taskkill /T）。
    kill_process_tree(pid)


def pending_followups() -> List[Dict[str, Any]]:
    """已完成但 agent 尚未重新调用的作业。监视器消耗这些作业；
    mark_followed_up() 仅在成功时翻转标志。"""
    jobs = refresh()
    return [r for r in jobs.values()
            if r.get("status") in ("done", "failed") and not r.get("followed_up")]


def mark_followed_up(job_id: str) -> None:
    jobs = _load()
    if job_id in jobs:
        jobs[job_id]["followed_up"] = True
        _save(jobs)


def get(job_id: str) -> Optional[Dict[str, Any]]:
    refresh()  # 与磁盘对账，使 status/exit_code 保持最新
    rec = _load().get(job_id)
    if rec:
        rec = dict(rec)
        rec["output"] = _read_output(rec)
    return rec


def list_for_session(session_id: str) -> List[Dict[str, Any]]:
    return [r for r in refresh().values() if r.get("session_id") == session_id]


def result_text(rec: Dict[str, Any]) -> str:
    """已完成作业的人类/agent 可读摘要，用于跟进。"""
    out = _read_output(rec)
    if rec.get("timed_out"):
        head = f"Background job timed out after {rec.get('max_runtime_s')}s."
    elif rec.get("died"):
        head = "Background job process died unexpectedly (no exit code)."
    else:
        head = f"Background job finished with exit code {rec.get('exit_code')}."
    return f"{head}\nCommand: {rec.get('command')}\n\nOutput:\n{out or '(no output)'}"
