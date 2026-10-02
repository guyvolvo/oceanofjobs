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
# How long the applier may wait before a long holder steps aside for it.
LET_THROUGH_AFTER_S = 5 * 60
# The lock this process holds, if any, so a long job can hand it over
# between its own steps (let_through) without unwinding its stack.
_held: dict = {}


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


def note_waiting(who: str) -> None:
    """Leave or refresh a marker saying `who` wants the disk. The file
    holds when the wait began; the mtime says the waiter is still alive."""
    p = _want_path(who)
    try:
        if p.exists():
            os.utime(p)
        else:
            p.write_text(f"{time.time():.0f}", encoding="utf-8")
    except OSError:
        pass


def clear_waiting(who: str) -> None:
    _want_path(who).unlink(missing_ok=True)


def _waited(who: str) -> float:
    """Seconds `who` has been waiting, 0 when it is not (or its marker
    is stale, a waiter that died)."""
    p = _want_path(who)
    try:
        if time.time() - p.stat().st_mtime > WANT_MAX_AGE_S:
            return 0
        return time.time() - float(p.read_text(encoding="utf-8").strip() or 0)
    except (OSError, ValueError):
        return 0


def let_through(waiter: str = "apply", after: float = LET_THROUGH_AFTER_S, max_wait: float = 900) -> bool:
    """Called by a long holder (the publisher) between its own steps.
    When `waiter` has been waiting for `after` seconds, release the disk,
    wait for that job to take it and finish (its marker goes when it
    does), then take the disk back. Returns whether it stepped aside.

    The publisher's precompute is fifty passes over the open rows and
    usually 5 to 10 minutes, but on a cold page cache it ran 22, 42 and
    65 minutes (2026-10-01/02). The applier sat out every one of them,
    and the fragment backlog passed fifty and fired the alarm."""
    if not _held or _waited(waiter) < after:
        return False
    import fcntl
    fd, who = _held["fd"], _held["who"]
    mine = _want_path(who)
    mine.unlink(missing_ok=True)  # or the waiter sees us waiting and yields back
    fcntl.flock(fd, fcntl.LOCK_UN)
    print(f"{who}: letting {waiter} through", file=sys.stderr)
    deadline = time.monotonic() + max_wait
    while _waited(waiter) > 0 and time.monotonic() < deadline:
        time.sleep(2)
    # Say we are waiting again, so the applier sits out its next tick and
    # the lock comes free within the apply now running, if one is.
    try:
        mine.write_text(str(os.getpid()), encoding="utf-8")
    except OSError:
        pass
    fcntl.flock(fd, fcntl.LOCK_EX)
    os.truncate(fd, 0)
    os.lseek(fd, 0, os.SEEK_SET)
    os.write(fd, f"{who} pid {os.getpid()}".encode("utf-8"))
    return True


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
        _held.update(fd=fd, who=who)
        yield True
    finally:
        _held.clear()
        if want:
            want.unlink(missing_ok=True)
        os.close(fd)
