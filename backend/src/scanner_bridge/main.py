from __future__ import annotations

import argparse
import asyncio
import logging
import os
import signal
import sys
from typing import Optional

import uvicorn

from scanner_bridge.api import create_app
from scanner_bridge.config import AppConfig, load_config


logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("scanner_bridge")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Scanner Bridge backend")
    parser.add_argument("--config", help="Path to YAML or TOML config")
    parser.add_argument("--port", help="Serial port override")
    parser.add_argument("--api-host", help="API host override")
    parser.add_argument("--api-port", type=int, help="API port override")
    parser.add_argument("--foreground", action="store_true", help="Run in foreground")
    parser.add_argument("--daemon", action="store_true", help="Run as daemon")
    parser.add_argument("--pid-file", default="/var/run/scanner-bridge.pid")
    parser.add_argument("--log-file", default="/var/log/scanner-bridge.log")
    return parser.parse_args()


async def _foreground_console(app) -> None:
    while not hasattr(app.state, "runtime"):
        await asyncio.sleep(0.1)
    runtime = app.state.runtime
    print("Scanner Bridge foreground mode (h=hold, s=scan, q=quit)")
    while True:
        try:
            line = await asyncio.to_thread(sys.stdin.read, 1)
        except Exception:
            return
        if not line:
            await asyncio.sleep(0.1)
            continue
        key = line.strip().lower()
        if key == "h":
            await runtime.driver.send_hold()
        elif key == "s":
            await runtime.driver.send_scan()
        elif key == "q":
            return


async def _foreground_status(app) -> None:
    while not hasattr(app.state, "runtime"):
        await asyncio.sleep(0.1)
    runtime = app.state.runtime
    while True:
        state = runtime.state_store.get_live_state()
        output = (
            f"\r{state.frequency:.4f} {state.modulation} "
            f"RSSI {state.rssi} "
            f"{'OPEN' if state.squelch_open else 'CLOSE'} "
            f"CH {state.channel or '-'} "
            f"{'STALE' if state.stale else '     '}"
        )
        print(output, end="", flush=True)
        await asyncio.sleep(0.5)


async def run_foreground(app, host: str, port: int) -> None:
    config = uvicorn.Config(app, host=host, port=port, log_level="info")
    server = uvicorn.Server(config)
    server_task = asyncio.create_task(server.serve())
    status_task = asyncio.create_task(_foreground_status(app))
    console_task = asyncio.create_task(_foreground_console(app))
    done, _ = await asyncio.wait(
        [server_task, status_task, console_task], return_when=asyncio.FIRST_COMPLETED
    )
    for task in done:
        if task is console_task:
            server.should_exit = True
    await server_task
    status_task.cancel()
    console_task.cancel()


def _daemonize(pid_file: str, log_file: str) -> None:
    if os.name != "posix":
        raise RuntimeError("Daemon mode is only supported on POSIX systems")
    pid = os.fork()
    if pid > 0:
        sys.exit(0)
    os.setsid()
    pid = os.fork()
    if pid > 0:
        sys.exit(0)
    os.umask(0)
    sys.stdout.flush()
    sys.stderr.flush()
    with open("/dev/null", "rb") as devnull:
        os.dup2(devnull.fileno(), sys.stdin.fileno())
    log_handle = open(log_file, "a", buffering=1)
    os.dup2(log_handle.fileno(), sys.stdout.fileno())
    os.dup2(log_handle.fileno(), sys.stderr.fileno())
    with open(pid_file, "w", encoding="ascii") as handle:
        handle.write(str(os.getpid()))


def _install_signal_handlers(server: uvicorn.Server, app, config_path: Optional[str]) -> None:
    def handle_exit(signum, frame):
        server.should_exit = True

    def handle_reload(signum, frame):
        logger.info("SIGHUP received; reload config requested.")
        app.state.runtime.config = load_config(config_path)

    signal.signal(signal.SIGTERM, handle_exit)
    signal.signal(signal.SIGINT, handle_exit)
    if hasattr(signal, "SIGHUP"):
        signal.signal(signal.SIGHUP, handle_reload)


def run_server(
    app,
    host: str,
    port: int,
    daemon: bool,
    pid_file: str,
    log_file: str,
    config_path: Optional[str],
) -> None:
    if daemon:
        _daemonize(pid_file, log_file)
    config = uvicorn.Config(app, host=host, port=port, log_level="info")
    server = uvicorn.Server(config)
    _install_signal_handlers(server, app, config_path)
    asyncio.run(server.serve())


def main() -> None:
    args = parse_args()
    config = load_config(args.config)
    if args.api_host:
        config.api.host = args.api_host
    if args.api_port:
        config.api.port = args.api_port

    if args.daemon and args.foreground:
        print("Choose either --daemon or --foreground", file=sys.stderr)
        sys.exit(2)

    app = create_app(config, port_override=args.port)
    if args.foreground:
        asyncio.run(run_foreground(app, config.api.host, config.api.port))
        return
    run_server(
        app,
        config.api.host,
        config.api.port,
        args.daemon,
        args.pid_file,
        args.log_file,
        args.config,
    )


if __name__ == "__main__":
    main()
