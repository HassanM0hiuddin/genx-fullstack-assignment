import hashlib
import re

PII_PATTERNS = [
    re.compile(r"\b\d{3}-\d{2}-\d{4}\b"),
    re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b"),
    re.compile(r"\b(?:\d[ -]*?){13,16}\b"),
]

DEFAULT_ITERATIONS = 120_000


def scrub(raw_text: str) -> str:
    """Redact common PII patterns. Cheap (microseconds), safe to run on the event loop."""
    cleaned = raw_text
    for pattern in PII_PATTERNS:
        cleaned = pattern.sub("[REDACTED]", cleaned)
    return cleaned


def fingerprint(cleaned_text: str, blob_iterations: int = DEFAULT_ITERATIONS) -> str:
    """
    Deterministic cryptographic fingerprint of already-scrubbed text.
    CPU-bound (~40-60ms) and holds the GIL (hashlib only releases it for inputs
    larger than 2 KiB), so it must run in a separate process, never on the event loop.
    """
    digest = cleaned_text.encode("utf-8")
    for _ in range(blob_iterations):
        digest = hashlib.sha256(digest).digest()
    return digest.hex()


def scrub_and_fingerprint(raw_text: str, blob_iterations: int = DEFAULT_ITERATIONS) -> tuple[str, str]:
    """Kept for backwards compatibility: same output as the original function."""
    cleaned = scrub(raw_text)
    return cleaned, fingerprint(cleaned, blob_iterations)


def warm_up() -> None:
    """No-op submitted to each pool worker at startup so the first real job doesn't pay process spawn cost."""
    return None


def _exit_when_parent_dies(parent_pid: int) -> None:
    import os
    import sys
    import time

    if sys.platform == "win32":
        import ctypes

        SYNCHRONIZE = 0x00100000
        INFINITE = 0xFFFFFFFF
        kernel32 = ctypes.windll.kernel32
        handle = kernel32.OpenProcess(SYNCHRONIZE, False, parent_pid)
        if handle:
            kernel32.WaitForSingleObject(handle, INFINITE)
        os._exit(0)
    else:
        while os.getppid() == parent_pid:
            time.sleep(1.0)
        os._exit(0)


def init_worker(parent_pid: int) -> None:
    """
    Pool worker initializer. If the server process is killed hard (SIGKILL, or
    TerminateProcess on Windows) the pool never gets a chance to shut down, and
    the worker processes would be left running as orphans. A daemon thread in each
    worker waits for the parent to disappear and then exits the worker.
    """
    import threading

    _lower_priority()
    threading.Thread(target=_exit_when_parent_dies, args=(parent_pid,), daemon=True).start()


def _lower_priority() -> None:
    """
    Hashing is background work. Running it at a lower OS priority means the
    process serving HTTP (and /health) always gets the CPU first when cores are busy.
    """
    import os
    import sys

    try:
        if sys.platform == "win32":
            import ctypes

            BELOW_NORMAL_PRIORITY_CLASS = 0x00004000
            kernel32 = ctypes.windll.kernel32
            kernel32.SetPriorityClass(kernel32.GetCurrentProcess(), BELOW_NORMAL_PRIORITY_CLASS)
        else:
            os.nice(10)
    except Exception:
        pass
