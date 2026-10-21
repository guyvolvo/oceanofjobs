"""Settles expired application reservations (api/attempts.py) for every
user, so expiry never depends on a client calling in (contract R9).

Runs every 5 minutes on otj-attempt-sweep.timer. Safe to repeat and to
overlap: every settlement is conditioned on the attempt's current state.
A run that fails leaves the reservations as they were; the next run, or
the user's next read, settles them.

    python box/attempt_sweep.py
"""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "api"))

import boto3  # noqa: E402

import attempts  # noqa: E402


def main() -> int:
    table = boto3.resource("dynamodb").Table(os.environ["ALERTS_TABLE"])
    settled = attempts.Attempts(table).sweep()
    print(f"attempt sweep: settled {settled}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
