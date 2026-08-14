"""Persistent backend logging shared by development and frozen entry points."""

from __future__ import annotations

import json
import logging
import re
import time
from logging.handlers import RotatingFileHandler
from pathlib import Path


LOG_FILE_NAME = "server.log"
LOG_MAX_BYTES = 5 * 1024 * 1024
LOG_BACKUP_COUNT = 2


class _JsonLineFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        line = super().format(record)
        line = re.sub(r"\x1b\[[0-9;]*m", "", line)
        return json.dumps(
            {
                "timestamp": int(time.time() * 1000),
                "stream": "stderr",
                "line": line,
            },
            ensure_ascii=False,
        )


def configure_persistent_logging(data_dir: str | Path) -> Path:
    """Append all Python and Uvicorn logs to a bounded UTF-8 JSONL file."""
    log_dir = Path(data_dir).resolve() / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / LOG_FILE_NAME

    root = logging.getLogger()
    resolved = str(log_path)
    for handler in root.handlers:
        if getattr(handler, "_voicebox_log_path", None) == resolved:
            return log_path

    try:
        handler = RotatingFileHandler(
            log_path,
            maxBytes=LOG_MAX_BYTES,
            backupCount=LOG_BACKUP_COUNT,
            encoding="utf-8",
        )
    except PermissionError:
        # Windows can briefly retain an exclusive handle after a forced
        # backend shutdown. Logging must never prevent the server from
        # starting; use a process-specific fallback until the next restart.
        import os

        log_path = log_dir / f"server-{os.getpid()}.log"
        handler = RotatingFileHandler(
            log_path,
            maxBytes=LOG_MAX_BYTES,
            backupCount=1,
            encoding="utf-8",
        )
    handler._voicebox_log_path = resolved  # type: ignore[attr-defined]
    handler.setFormatter(
        _JsonLineFormatter("%(asctime)s - %(name)s - %(levelname)s - %(message)s")
    )
    root.addHandler(handler)

    # Uvicorn installs non-propagating loggers, so attach the same handler there.
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        logger = logging.getLogger(name)
        if handler not in logger.handlers:
            logger.addHandler(handler)

    return log_path
