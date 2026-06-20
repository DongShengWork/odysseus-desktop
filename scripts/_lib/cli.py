"""scripts/_lib/cli.py — `odysseus-*` CLI 的共享脚手架。

每个顶级 CLI 从这里导入一些辅助函数，这样它们就不必
重复定义相同的 `_quiet_logs` / `_emit` / `_fail` /
parents-parser 模式。用法：

    from scripts._lib.cli import quiet_logs, emit, fail, common_parser, run

    quiet_logs()
    try:
        from core.database import SessionLocal, Note  # 或其他
        quiet_logs()
    except ModuleNotFoundError as e:
        fail(f"{e}\\nhint: run from repo root with venv active.", code=2)

    def cmd_list(args):
        ...

    def build_parser():
        p = common_parser("odysseus-foo", "Description.")
        sub = p.add_subparsers(dest="cmd", required=True)
        pl = sub.add_parser("list", parents=[p._common_parents[0]])
        pl.set_defaults(func=cmd_list)
        return p

    if __name__ == "__main__":
        sys.exit(run(build_parser()))

`--pretty` 标志、repo-root-on-sys.path 以及 KeyboardInterrupt /
意外异常的干净退出均由中央统一处理。
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from pathlib import Path

# 使仓库根目录可导入。工具以 `scripts/odysseus-foo` 形式从任意
# cwd 调用；我们希望 `from core.database import ...` 能正常工作。
REPO_ROOT = Path(__file__).resolve().parent.parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))


def quiet_logs() -> None:
    """将根日志记录器强制降级到 WARNING（可通过 LOG_LEVEL=... 覆盖）。
    在导入应用模块之前调用一次，并在 *之后* 再调用一次 —
    某些子模块在其自身导入期间调用 `logging.basicConfig` 并将级别
    重新提升到 INFO。"""
    level_name = os.environ.get("LOG_LEVEL", "WARNING").upper()
    level = getattr(logging, level_name, logging.WARNING)
    root = logging.getLogger()
    root.setLevel(level)
    for handler in root.handlers:
        handler.setLevel(level)


def emit(obj, args) -> None:
    """将 JSON 写入 stdout。如果传入了 `--pretty` 或 stdout 是 TTY，
    则进行美化打印。使用 `default=str` 使 SQLAlchemy 日期时间等
    能干净序列化。"""
    pretty = getattr(args, "pretty", False) or sys.stdout.isatty()
    json.dump(
        obj, sys.stdout,
        indent=2 if pretty else None,
        default=str,
        ensure_ascii=False,
    )
    sys.stdout.write("\n")


def fail(msg: str, code: int = 1) -> "None":
    """向 stderr 打印错误并以非零状态退出。不返回。"""
    sys.stderr.write(f"error: {msg}\n")
    sys.exit(code)


VERSION = "0.1.0"  # 集中更新；每个 odysseus-* CLI 都报告此版本


def common_parser(prog: str, description: str = "") -> argparse.ArgumentParser:
    """返回一个已配置好 `--pretty` 和 `--version` 的顶级解析器，
    并存储一个 `_common_parents` 列表，每个子命令应通过
    `parents=[...]` 复用它，以便相同的标志在子命令名称之前和之后
    都能使用。"""
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--pretty", action="store_true",
                        help="Pretty-print JSON output")

    p = argparse.ArgumentParser(prog=prog, description=description, parents=[common])
    p.add_argument("--version", action="version", version=f"%(prog)s {VERSION}")
    p._common_parents = [common]  # 由调用方在构建子解析器时使用
    return p


def run(parser: argparse.ArgumentParser, argv=None) -> int:
    """解析参数，分发到 `args.func(args)`，返回退出码。
    捕获 KeyboardInterrupt (→ 130) 和未捕获异常 (→ 1)，
    并输出友好的 stderr 消息。

    Intercepts `--version` / `-V` before argparse can complain about the
    否则子解析器上的 `argparse.required=True` 会先触发。"""
    subparsers fires first otherwise."""
    raw_argv = sys.argv[1:] if argv is None else list(argv)
    if any(a in ("--version", "-V") for a in raw_argv):
        sys.stdout.write(f"{parser.prog} {VERSION}\n")
        return 0

    args = parser.parse_args(argv)
    try:
        args.func(args)
    except KeyboardInterrupt:
        sys.stderr.write("interrupted\n")
        return 130
    except SystemExit:
        raise
    except Exception as e:
        fail(str(e))
    return 0
