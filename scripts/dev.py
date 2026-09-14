#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
HOST = "127.0.0.1"
UI_PORT = 5173
API_PORT = 8000


def port_is_open(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as connection:
        connection.settimeout(0.25)
        return connection.connect_ex((HOST, port)) == 0


def fetch_text(url: str) -> str | None:
    try:
        with urllib.request.urlopen(url, timeout=1) as response:
            return response.read().decode("utf-8", errors="replace")
    except (OSError, urllib.error.URLError):
        return None


def listener_pids(port: int) -> list[int]:
    result = subprocess.run(
        [
            "lsof",
            "-nP",
            f"-iTCP:{port}",
            "-sTCP:LISTEN",
            "-t",
        ],
        capture_output=True,
        text=True,
        timeout=2,
        check=False,
    )
    return [
        int(value)
        for value in result.stdout.splitlines()
        if value.strip().isdigit()
    ]


def process_is_from_project(pid: int) -> bool:
    result = subprocess.run(
        ["lsof", "-nP", "-a", "-p", str(pid), "-d", "cwd", "-Fn"],
        capture_output=True,
        text=True,
        timeout=2,
        check=False,
    )
    cwd_values = [
        line[1:] for line in result.stdout.splitlines() if line.startswith("n")
    ]
    return any(Path(value).resolve() == ROOT for value in cwd_values)


def stop_stale_project_service(port: int) -> bool:
    pids = listener_pids(port)
    if not pids or not all(process_is_from_project(pid) for pid in pids):
        return False

    print(
        f"Stopping stale Chapter Master process"
        f"{'es' if len(pids) != 1 else ''} on port {port}: "
        + ", ".join(str(pid) for pid in pids)
    )
    for pid in pids:
        os.kill(pid, signal.SIGTERM)

    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        if not port_is_open(port):
            return True
        time.sleep(0.1)

    remaining = [
        pid
        for pid in listener_pids(port)
        if pid in pids and process_is_from_project(pid)
    ]
    if remaining:
        print(
            "Processes did not stop gracefully; force-stopping stale "
            "Chapter Master listeners: "
            + ", ".join(str(pid) for pid in remaining)
        )
        for pid in remaining:
            os.kill(pid, signal.SIGKILL)

    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        if not port_is_open(port):
            return True
        time.sleep(0.1)
    return not port_is_open(port)


def api_is_healthy() -> bool:
    health = fetch_text(f"http://{HOST}:{API_PORT}/api/health")
    if health is None:
        return False
    try:
        return json.loads(health).get("status") == "ok"
    except (json.JSONDecodeError, AttributeError):
        return False


def ui_is_healthy() -> bool:
    page = fetch_text(f"http://{HOST}:{UI_PORT}/")
    return page is not None and "<title>Chapter Master</title>" in page


def service_status() -> tuple[bool, bool] | None:
    api_open = port_is_open(API_PORT)
    ui_open = port_is_open(UI_PORT)

    if api_open and not api_is_healthy():
        if stop_stale_project_service(API_PORT):
            api_open = False
        else:
            print(
                f"Port {API_PORT} is occupied by another process, but it is "
                "not a healthy Chapter Master API."
            )
            return None

    if ui_open and not ui_is_healthy():
        if stop_stale_project_service(UI_PORT):
            ui_open = False
        else:
            print(
                f"Port {UI_PORT} is occupied by another process, but it is "
                "not a healthy Chapter Master UI."
            )
            return None

    return api_open, ui_open


def main() -> int:
    python = ROOT / ".venv" / "bin" / "python"
    if not python.exists():
        print("Missing .venv. Run the setup commands in README.md first.")
        return 1

    status = service_status()
    if status is None:
        print("Stop the conflicting process or change the configured port.")
        return 1
    api_running, ui_running = status

    if api_running:
        print(f"Reusing Chapter Master API at http://{HOST}:{API_PORT}")
    if ui_running:
        print(f"Reusing Chapter Master UI at http://{HOST}:{UI_PORT}")
    if api_running and ui_running:
        print("Chapter Master is already running.")
        return 0

    processes: list[subprocess.Popen] = []
    if not api_running:
        processes.append(
            subprocess.Popen(
                [
                    str(python),
                    "-m",
                    "uvicorn",
                    "backend.server:app",
                    "--host",
                    HOST,
                    "--port",
                    str(API_PORT),
                ],
                cwd=ROOT,
            )
        )
    if not ui_running:
        processes.append(
            subprocess.Popen(
                [
                    "npm",
                    "run",
                    "dev:ui",
                ],
                cwd=ROOT,
            )
        )

    print(f"Chapter Master UI: http://{HOST}:{UI_PORT}")
    print(f"PDF export API: http://{HOST}:{API_PORT}")

    def stop(*_: object) -> None:
        for process in processes:
            if process.poll() is None:
                process.terminate()

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)

    try:
        while all(process.poll() is None for process in processes):
            time.sleep(0.25)
    finally:
        stop()
        for process in processes:
            process.wait()

    return next(
        (process.returncode for process in processes if process.returncode), 0
    )


if __name__ == "__main__":
    sys.exit(main())
