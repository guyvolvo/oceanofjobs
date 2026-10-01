"""One lock shared by the two jobs that are heavy on disk.

Measured on the box while an apply and a VACUUM INTO ran together: IO
wait at 87%, no apply completing in twenty minutes, and EBSIOBalance%
falling about ten points every ten minutes. A t4g.small's sustained
IOPS are the limit, and two jobs both walking a 2.6GB file is well past
it. Neither job is urgent to the second, so they take turns instead.

flock, not a pid file. The kernel releases it when the process ends,
however it ends, so a killed or OOM'd apply cannot strand the lock the
way a file someone forgot to delete would.

The applier and the snapshot are non-blocking and simply leave if the
lock is held; each runs again on its next trigger. The publisher waits
(bounded), because it fires every fifteen minutes and the applier was
holding the disk about half the time: non-blocking, it published
nothing for three hours (2026-10-01) and the board's precomputed stats
went stale.
"""

import os
import sys
import time
from contextlib import contextmanager
from pathlib import Path

LOCK_PATH = Path(os.environ.get("DATA_PATH", "/var/lib/otj/jobs.db")).with_name("heavy-io.lock")


WANT_MAX_AGE_S = 15 * 60


def _want_path(who: str) -> Path:
    return LOCK_PATH.with_name(f"heavy-io.want-{who}")


def someone_waiting(but: str = "") -> str | None:
    """The name of a job that is waiting for the disk, or None. A waiter
    leaves a marker while it waits; a marker older than a cadence is a
    job that died waiting and is ignored."""
    now = time.time()
    for p in LOCK_PATH.parent.glob("heavy-io.want-*"):
        who = p.name[len("heavy-io.want-"):]
        if who == but:
            continue
        try:
            if now - p.stat().st_mtime < WANT_MAX_AGE_S:
                return who
        except OSError:
            pass
    return None


@contextmanager
def exclusive(who: str, wait: float = 0):
    """Yields True when this process has the lock, False when another
    job holds it, after trying for up to `wait` seconds. On a platform
    without flock (a developer's Windows box, where neither job runs
    anyway) it always yields True."""
    try:
        import fcntl
    except ImportError:
        yield True
        return

    fd = os.open(LOCK_PATH, os.O_CREAT | os.O_RDWR, 0o644)
    want = _want_path(who) if wait > 0 else None
    if want:
        # Says "I am waiting", so the applier, which otherwise runs back
        # to back, sits out one tick and the lock comes free.
        try:
            want.write_text(str(os.getpid()), encoding="utf-8")
        except OSError:
            want = None
    try:
        deadline = time.monotonic() + wait
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError:
                if time.monotonic() < deadline:
                    time.sleep(2)
                    continue
                holder = ""
                try:
                    holder = os.read(fd, 64).decode("utf-8", "replace").strip()
                except OSError:
                    pass
                print(f"{who}: skipped, {holder or 'another job'} holds the disk",
                      file=sys.stderr)
                yield False
                return
        os.truncate(fd, 0)
        os.lseek(fd, 0, os.SEEK_SET)
        os.write(fd, f"{who} pid {os.getpid()}".encode("utf-8"))
        yield True
    finally:
        if want:
            want.unlink(missing_ok=True)
        os.close(fd)
