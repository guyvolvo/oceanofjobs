import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "box"))

import apply_company_names as acn


def test_referral_board_name_beats_an_old_resolved_name(tmp_path, monkeypatch):
    db = tmp_path / "jobs.db"
    (tmp_path / acn.NAMES_KEY).write_text(json.dumps({"referralsuseonly.com": "Referral Board"}), encoding="utf-8")
    monkeypatch.setattr(acn, "DB", db)
    assert acn.load_names("")["referralsuseonly.com"] == "Elastic (referrals)"
