"""The custom AI agent's settings (api/AI_AGENT_DESIGN.md, step 1): how
answers sound, facts the user states about themselves, fixed answers by
topic, things never to claim, and whether new AI answers wait for review.

One row per agent, #agent#<agent_id>; v1 has "default" only, so profiles
can point at agents later without moving anything. Saves are conditional
on the version the editor loaded, so a second tab gets a conflict instead
of overwriting. Basic and Pro only (PLANS); Free gets AI answers from
the default agent.

ai_answers.draft reads it (step 2): topic rules before the model, the
user's style and facts in the prompt, and check_answer on every answer.
"""

import re
from datetime import datetime, timezone

import apply
import ai_answers

AGENT = "#agent#"
DEFAULT_ID = "default"
TONES = ("plain", "warm", "formal")
LENGTHS = ("short", "medium")
# The answer's language: the question's own, or one the user picks.
LANGUAGE_NAMES = {"en": "English", "he": "Hebrew", "es": "Spanish", "fr": "French", "de": "German", "pt": "Portuguese",
                  "it": "Italian", "nl": "Dutch"}
LANGUAGES = ("question", *LANGUAGE_NAMES)
REVIEW = ("pause", "use")
ACTIONS = ("answer", "ai", "ask")
# v1's topics: the most common unanswered questions. why_company and why_role
# are job-specific (apply.job_specific), so they can't have one fixed answer.
TOPICS = ("referral_source", "start_date", "relocation", "onsite_days", "why_company", "why_role")
JOB_TOPICS = ("why_company", "why_role")
MAX_NOTES, MAX_FACTS, MAX_FACT, MAX_NEVER, MAX_NEVER_LEN, MAX_VALUE = 500, 20, 300, 30, 100, 300
# Facts the profile already holds. One place per fact, so the prompt never
# carries two answers to one question.
PROFILE_FACT = re.compile(r"\b(salary|notice period|sponsorship|work visa|work permit|authori[sz]ed to work|right to work|"
                          r"citizenship|i live in|i (am|m) (based|located) in)\b")


class Conflict(Exception):
    """Saved meanwhile from somewhere else: reload and try again."""


# The plans whose users may change their agent.
PLANS = ("basic", "pro")


class NotIncluded(Exception):
    pass


def defaults() -> dict:
    # Medium, not short: today's answers run to three sentences, and the
    # defaults shouldn't refuse what AI answers gave before the agent.
    return {"version": 0, "updated_at": None,
            "style": {"tone": "plain", "length": "medium", "language": "question", "notes": ""},
            "facts": [], "topics": {t: {"action": "ai", "value": ""} for t in TOPICS},
            "never_claim": [], "review": "pause"}


def _choice(value, allowed, field):
    if value not in allowed:
        raise ValueError(f"{field} must be one of: {', '.join(allowed)}")
    return value


def _text(value, limit, field):
    text = str(value or "").strip()
    if len(text) > limit:
        raise ValueError(f"{field} can be at most {limit} characters")
    return text


def clean(body: dict) -> dict:
    """The agent as stored. Every field bounded, every choice from a closed
    list; a bad field is refused with its name, not silently dropped."""
    body = body if isinstance(body, dict) else {}
    out = defaults()
    style = body.get("style") or {}
    out["style"] = {"tone": _choice(style.get("tone", "plain"), TONES, "style.tone"),
                    "length": _choice(style.get("length", "medium"), LENGTHS, "style.length"),
                    "language": _choice(style.get("language", "question"), LANGUAGES, "style.language"),
                    "notes": _text(style.get("notes"), MAX_NOTES, "style.notes")}
    facts = body.get("facts") or []
    if len(facts) > MAX_FACTS:
        raise ValueError(f"facts can have at most {MAX_FACTS} entries")
    out["facts"] = []
    for i, f in enumerate(facts):
        text = _text((f or {}).get("text"), MAX_FACT, f"facts[{i}]")
        if not text:
            continue
        if PROFILE_FACT.search(apply.normalise_question(text)):
            raise ValueError(f"facts[{i}]: salary, notice period, work authorization, sponsorship and location "
                             "belong in your profile, so the agent has one answer for each")
        out["facts"].append({"id": str((f or {}).get("id") or i)[:40], "text": text})
    topics = body.get("topics") or {}
    for name, rule in topics.items():
        if name not in TOPICS:
            raise ValueError(f"topics: unknown topic {name}")
        action = _choice((rule or {}).get("action", "ai"), ACTIONS, f"topics.{name}.action")
        if action == "answer" and name in JOB_TOPICS:
            raise ValueError(f"topics.{name}: this question is about one company or role, so it can't have one fixed answer")
        value = _text((rule or {}).get("value"), MAX_VALUE, f"topics.{name}.value")
        if action == "answer" and not value:
            raise ValueError(f"topics.{name}.value is required to answer it")
        out["topics"][name] = {"action": action, "value": value if action == "answer" else ""}
    never = body.get("never_claim") or []
    if len(never) > MAX_NEVER:
        raise ValueError(f"never_claim can have at most {MAX_NEVER} entries")
    out["never_claim"] = [t for t in (_text(n, MAX_NEVER_LEN, f"never_claim[{i}]") for i, n in enumerate(never)) if t]
    out["review"] = _choice(body.get("review", "pause"), REVIEW, "review")
    return out


def get(table, user_id: str, agent_id: str = DEFAULT_ID) -> dict:
    """The agent, or the defaults at version 0 if never saved, and whether
    this plan can change it."""
    row = table.get_item(Key={"user_id": user_id, "alert_id": AGENT + agent_id}, ConsistentRead=True).get("Item")
    agent = {k: row[k] for k in defaults()} if row else defaults()
    agent["version"] = int(agent["version"])
    return {**agent, "editable": apply.plan_of(table, user_id) in PLANS, "resume": resume_view(get_resume(table, user_id, agent_id))}


# Turning on a setting that acts without the user checking first needs a
# resume: answers and matches are then drawn from it, not from a few facts.
# A setting already on stays on.
NEEDS_RESUME = "Add your resume on the AI agent tab to use this setting"


def put(table, user_id: str, body: dict, now: datetime | None = None, agent_id: str = DEFAULT_ID) -> dict:
    """Saves the agent if it's still at body["version"]; Conflict if it was
    saved meanwhile. The version goes up by one."""
    now = now or datetime.now(timezone.utc)
    if apply.plan_of(table, user_id) not in PLANS:
        raise NotIncluded("Your own AI agent is part of Basic and Pro")
    try:
        expected = int((body or {}).get("version"))
    except (TypeError, ValueError):
        raise ValueError("version is required: the one the agent was loaded at") from None
    item = {**clean(body), "version": expected + 1, "updated_at": now.isoformat(), "user_id": user_id, "alert_id": AGENT + agent_id}
    if item["review"] == "use" and load(table, user_id, agent_id)["review"] != "use" and not get_resume(table, user_id, agent_id):
        raise ValueError(NEEDS_RESUME)
    cond = ({"ConditionExpression": "attribute_not_exists(alert_id)"} if expected == 0 else
            {"ConditionExpression": "version = :v", "ExpressionAttributeValues": {":v": expected}})
    try:
        table.put_item(Item=item, **cond)
    except Exception as e:  # noqa: BLE001
        if getattr(e, "response", {}).get("Error", {}).get("Code") == "ConditionalCheckFailedException":
            raise Conflict("The agent was changed somewhere else. Reload to see the latest version.") from None
        raise
    return get(table, user_id, agent_id)


def load(table, user_id: str, agent_id: str = DEFAULT_ID) -> dict:
    """The agent as the pipeline uses it: the saved row or the defaults."""
    row = table.get_item(Key={"user_id": user_id, "alert_id": AGENT + agent_id}).get("Item")
    out = {k: row[k] for k in defaults()} if row else defaults()
    out["version"] = int(out["version"])
    return out


# Which of the six topics a question is, from its words; the extension's
# field key wins when it names one. Matched on the normalised question.
TOPIC_RE = {
    "referral_source": re.compile(r"\bhow did you (hear|find out|learn|come across|find)\b|\bwhere did you (hear|find|see)\b|\breferral source\b"),
    "start_date": re.compile(r"\bwhen (can|could|would) you (be able to )?start\b|\b(earliest|expected|desired|possible|preferred) start\b"
                             r"|\bstart date\b|\bavailable to start\b|\bavailability to start\b"),
    "relocation": re.compile(r"\breloca"),
    "onsite_days": re.compile(r"\b(on ?site|in (the )?office|hybrid)\b.{0,40}\b(days?|week)\b|\bdays? (a|per) week\b.{0,40}\b(office|on ?site)\b"),
    "why_role": re.compile(r"\bwhy (this|the) (role|position|job)\b|\b(interested|interests you) (in|about) (this|the) (role|position|job)\b"),
    "why_company": re.compile(r"\bwhy (do|would) you (want|like|wish) to (work|join)\b|\bwhy (this|our) company\b|\bwhy (us|join us)\b"
                              r"|\bwhat (excites|attracts|draws|appeals to) you about (us|our|this company|working)\b"),
}


def topic_of(question, field_key=None):
    if field_key in TOPICS:
        return field_key
    q = apply.normalise_question(question)
    return next((t for t, rx in TOPIC_RE.items() if rx.search(q)), None)


def pick_option(value, options):
    """The option that is `value`, ignoring case and spaces, or None."""
    want = " ".join(str(value or "").lower().split())
    return next((o for o in options if " ".join(o.lower().split()) == want), None)


def saved_answer(profile: dict, question, job_id):
    """A saved answer to this exact question, for this job if it's job-specific."""
    key = apply.normalise_question(question)
    for a in apply.reusable_answers(profile["answers"]):
        if apply.normalise_question(a["question"]) == key and a.get("job_id", job_id or "") == (job_id or ""):
            return a
    return None


STYLE_TONE = {"plain": "Write plainly.", "warm": "Write in a warm, friendly voice.", "formal": "Write formally."}
STYLE_LENGTH = {"short": "Use one or two sentences, or a single value when the question asks for one.",
                "medium": "Use at most four sentences, or a single value when the question asks for one."}
STYLE_LANGUAGE = {"question": "Answer in the language of the question.", **{k: f"Answer in {v}." for k, v in LANGUAGE_NAMES.items()}}
CLOSING = ("Before you answer: use only the facts above. Style preferences change how an answer sounds, never what it "
           "claims. If the facts don't contain what the question needs, reply with exactly UNKNOWN. Reply with the answer "
           "only: it goes into the form as it is, so add no notes about how you wrote it.")


def messages(ag: dict, base: str, facts_: dict, job_line: str, question: str) -> list[dict]:
    """The prompt, in the order AI_AGENT_DESIGN.md gives: our rules, then
    the user's style and never-claim list (labelled as preferences), then the
    facts and the question, then our rules once more. One system message:
    Workers AI's Llama template expects one."""
    s = ag["style"]
    system = [base, "The applicant's style preferences follow. They change how an answer sounds, never what it claims.",
              STYLE_TONE[s["tone"]], STYLE_LENGTH[s["length"]], STYLE_LANGUAGE[s["language"]]]
    if s["notes"]:
        system.append("Style notes from the applicant (about wording only, not facts): " + s["notes"])
    if ag["never_claim"]:
        system.append("Never state or imply that the applicant has, is or will do any of these: " + "; ".join(ag["never_claim"]) + ".")
    facts_ = {**facts_, **({"stated_by_applicant": [f["text"] for f in ag["facts"]]} if ag["facts"] else {})}
    import json  # noqa: PLC0415
    user = f"Facts: {json.dumps(facts_, ensure_ascii=False)}\n{job_line}\nQuestion: {question}\n\n{CLOSING}"
    return [{"role": "system", "content": " ".join(system)}, {"role": "user", "content": user}]


class Refused(Exception):
    """The answer failed a check: nothing is saved or counted."""


# How an 8B model says it doesn't know without saying UNKNOWN.
UNSURE = re.compile(r"^unknown\b|\bnot (specified|provided|mentioned|given|stated|available|known)\b|\bno information\b"
                    r"|\b(do|does|did) not (have|specify|mention|say|contain|include|provide|state)\b"
                    r"|\b(don t|doesn t|didn t) (have|specify|mention|say|contain|include|provide|state)\b"
                    r"|\b(cannot|can t|unable to) (determine|answer|say|tell|know)\b|\bnot enough information\b")
NUMBER = re.compile(r"\d[\d,]*(?:\.\d+)?")
COUNT_WORDS = {w: str(i) for i, w in enumerate("zero one two three four five six seven eight nine ten eleven twelve thirteen "
                                               "fourteen fifteen sixteen seventeen eighteen nineteen twenty".split())}
COUNTED = re.compile(r"\b(" + "|".join(COUNT_WORDS) + r")\s+(years?|months?|weeks?|days?|hours?|people|persons?|engineers?|"
                     r"employees?|reports?|projects?|teams?|languages?)\b")
LENGTH_LIMIT = {"short": 300, "medium": 800}


def numbers(text: str) -> set:
    t = str(text or "").lower()
    found = {n.replace(",", "").rstrip(".") for n in NUMBER.findall(t)}
    return found | {COUNT_WORDS[m.group(1)] for m in COUNTED.finditer(t)}


# Yes/no questions, by their first word. These and choice questions must
# cite a fact (needs_support): a confident "No" with nothing behind it reads
# to an employer as a fact about the applicant.
YES_NO = re.compile(r"^(do|does|did|are|is|was|were|have|has|had|can|could|will|would|should|may)\b")
CITE = ("\nReply on one line: the answer, then \" | \", then the exact words from the facts that support it. "
        "If no fact supports an answer, reply with exactly UNKNOWN.")


def needs_support(question, options) -> bool:
    return bool(options) or bool(YES_NO.search(apply.normalise_question(question))) or bool(EVIDENCE.search(apply.normalise_question(question)))


# Personal traits only the applicant can state: never asked of the model.
# The live run answered "What is your biggest weakness?" with a
# self-description the profile doesn't contain.
TRAITS = re.compile(r"\b(greatest|biggest|main|key|top) (weakness|weaknesses|strength|strengths)\b|\bwhat (motivates|drives|inspires) you\b"
                    r"|\bdescribe yourself\b|\bthree words\b|\bpersonality\b|\bhobbies\b|\bwhat do you do (in|for) (your )?(free|spare) time\b"
                    r"|\bwhat are you passionate about\b|\bwork style\b"
                    # Facts about who they are and where they work now. On real forms
                    # the model answered "Full Legal Name" from the LinkedIn address,
                    # "Current Job Title" with the job applied for, and "Current
                    # Employer" with one the facts say they left in 2024.
                    r"|\b(legal|full) name\b|\bpronouns?\b|\bcitizenship\b|\bnationality\b|\bdate of birth\b|\bbirth ?date\b"
                    r"|\b(home|street|mailing) address\b|\bcurrent (job )?(title|employer|company|position|role|salary|compensation)\b"
                    r"|\b(current|present) (or (most )?recent )?employer\b"
                    # Follow-ups ("If yes, which visa type?", "If 'Other', please list.")
                    # ask for details the facts rarely hold: the model answered "H1-B".
                    # And open catch-alls, which it filled by repeating a fact.
                    r"|^if\b|\badditional information\b|\banything else\b")
# Examples and motivations: answered only from a stated fact, quoted
# (needs_support). Unlike a yes/no answer, the quote needn't share words
# with the question: "tell us about yourself" is about every fact.
EVIDENCE = re.compile(r"\btell (us|me) about (yourself|a time|a project|your)\b|\bdescribe (a|an|your|the) (\w+ )?(time|situation|project|challenge|"
                      r"accomplishment|achievement|experience|role)\b|\b(greatest|biggest|proudest) (achievement|accomplishment)\b"
                      r"|\bgive (us |me )?an example\b|\bwhy (do|would) you (want|like|wish)\b|\bwhy are you (interested|applying|excited)\b"
                      r"|\bwhy (this|our|us|join)\b|\bwhy should we hire\b|\bwhat makes you (a good|the right|a great|a strong)\b"
                      r"|\bcover (letter|note)\b|\binterests? you (about|in)\b"
                      r"|\b(good|great|strong|right|best) (fit|match|candidate)\b")


def is_trait(question) -> bool:
    return bool(TRAITS.search(apply.normalise_question(question)))


def _words(text) -> set:
    return {w for w in re.sub(r"[^a-z0-9]+", " ", str(text or "").lower()).split() if len(w) > 2 or w.isdigit()}


# Words that say nothing about what a question is about.
GENERIC = set("you your yours are have has had the and for with this that will would could should can did does any ever "
              "been being now future currently please how what when where which who why our their there here from into about "
              "able willing comfortable want like".split())


def _topic(text) -> set:
    """A text's meaningful words, roughly stemmed, so "working" meets "work"."""
    out = set()
    for w in _words(text) - GENERIC:
        for end in ("ing", "ed", "es", "s"):
            if w.endswith(end) and len(w) - len(end) >= 3:
                w = w[: -len(end)]
                break
        out.add(w)
    return out


# "Are you authorized to work in <country>?": answered from the profile's
# country list (ai_answers.draft) when it names one country. Only the
# question that asks whether they ARE allowed: "Do you need a work permit?"
# asks the opposite, and "yes, authorized" would answer it backwards.
WORK_AUTH = re.compile(r"^(are|is) you\b.*\b(authori[sz]ed|eligible|permitted|allowed|entitled) to work\b"
                       r"|^do you (have|hold) (the )?(legal )?right to work\b")


# An answer that agrees to what the question asks.
AFFIRMS = re.compile(r"^(yes|yeah|true|i do|i have|i am|i m|i hold|i can|i will|correct)\b")


def check_answer(text: str, *, options: list, allowed: str, never_claim: list, length: str, question: str = "",
                 support_from: str | None = None) -> str:
    """The answer as it may be used, or Refused with the reason. These are
    guardrails, not proof: review is the backstop (AI_AGENT_DESIGN.md).
    With support_from, the answer must end in " | <words from the facts>",
    every one of them found in support_from."""
    text = str(text or "").strip()
    plain = apply.normalise_question(text)
    if not plain or UNSURE.search(plain):
        raise Refused("your profile doesn't answer this question")
    if support_from is not None:
        first = text.splitlines()[0]
        answer, sep, support = first.partition("|") if "|" in first else text.rpartition("|")
        cited = _words(support)
        # The quoted fact has to exist and be about the question: the model
        # answered "Do you hold a PhD?" with "No | I led a team of five".
        on_topic = bool(_topic(support) & _topic(question)) or bool(EVIDENCE.search(apply.normalise_question(question)))
        if not sep or not cited or not cited <= _words(support_from) or not on_topic:
            raise Refused("no fact in your profile supports this answer")
        text = answer.strip()
        plain = apply.normalise_question(text)
        if not plain or UNSURE.search(plain):
            raise Refused("your profile doesn't answer this question")
    if not options:
        # The model adds notes about its own answer: "(I used a formal style...)".
        # They'd go into the form, so the answer stops before the first one.
        kept = []
        for para in re.split(r"\n\s*\n", text):
            if re.match(r"\s*(\(|note\b|i used\b|this answer\b)", para, re.I):
                break
            kept.append(para.strip())
        text = "\n\n".join(p for p in kept if p)
        if not text:
            raise Refused("your profile doesn't answer this question")
    if options:
        # The model adds a full stop or a note after the option ("Yes.",
        # "No\n\n(This answer is...)"): its first line, without them.
        first = text.splitlines()[0].strip().strip(".!\"'").strip()
        pick = pick_option(first, options)
        if pick is None:
            raise Refused("the answer wasn't one of the form's options")
        text = pick
        # A real choice (not yes or no) has to be one the facts name: citing
        # the sponsorship fact chose "H1-B", which no fact says.
        if support_from is not None and not re.match(r"^(yes|no|true|false|i do|i don t|i am|i m not|i am not)\b", apply.normalise_question(pick)) \
                and not set(re.sub(r"[^a-z0-9]+", " ", pick.lower()).split()) <= set(re.sub(r"[^a-z0-9]+", " ", support_from.lower()).split()):
            raise Refused("no fact in your profile names this option")
        plain = apply.normalise_question(text)
    padded = f" {plain} "
    asked = f" {apply.normalise_question(question)} "
    for phrase in never_claim:
        p = apply.normalise_question(phrase)
        if p and f" {p} " in padded:
            raise Refused(f"the answer claimed something you said never to claim ({phrase})")
        # "Do you have a PhD?" answered "Yes" claims it without the word.
        if p and f" {p} " in asked and AFFIRMS.search(plain):
            raise Refused(f"the answer agreed to something you said never to claim ({phrase})")
    invented = numbers(text) - numbers(allowed)
    if invented:
        raise Refused(f"the answer has numbers that aren't in your profile ({', '.join(sorted(invented))})")
    if not options and len(text) > LENGTH_LIMIT[length]:
        raise Refused("the answer was longer than your agent's length setting allows")
    return text


# Questions about what draws the applicant to this company or role. The AI
# may draft these from the job posting (what the company says about its
# product, team and work), never from generic praise, and the draft always
# waits for the user's review, even with "Send without review" on: it puts
# a motivation in their mouth. "Why are you a good fit?" isn't one of these:
# it's about the applicant, and quotes their facts (EVIDENCE).
MOTIVATION = re.compile(r"\bwhat do you like about\b|\bwhy (do|would) you (want|like|wish) to (work|join)\b|\bwhy (this|our) (company|team)\b"
                        r"|\bwhy (us|join us)\b|\bwhy (this|the) (role|position|job)\b|\bwhy are you (interested|applying|excited)\b"
                        r"|\bwhat (interests|excites|attracts|draws|appeals to) you (about|in|to)\b")
GENERIC_PRAISE = re.compile(r"\binnovat|\bcollaborative environment\b|\btalented team\b|\bexcited about the opportunity\b"
                            r"|\bimpressed by\b|\bexciting (opportunit|challenge)|\bcutting[ -]edge\b|\bworld[ -]class\b|\bdynamic (environment|team|company)\b"
                            r"|\b(great|amazing|strong|vibrant|inclusive) (company )?culture\b|\bpassionate about\b|\bfast[ -]paced\b"
                            r"|\bindustry leader\b|\bleading (company|player|provider)\b|\b(values|mission) (align|resonate)|\bgrowth opportunit")
MOTIVATION_PROMPT = (
    "This question asks what draws the applicant to this company or role. Write two or three sentences in the applicant's voice "
    "about specific things the job posting below says: the product, the problem the team works on, the technology. Say nothing "
    "about the applicant's own experience, skills or background; they add that themselves. No generic praise: don't call the "
    "company innovative, exciting, fast-paced or a leader, and don't mention its culture or mission unless the posting describes "
    "them. If the posting doesn't say enough to be specific, reply with exactly UNKNOWN.")
# A sentence about the applicant rather than the company. On real postings
# the drafts invented "Kafka and Kubernetes that I'm familiar with" and
# "experience working with Legal and Compliance"; such sentences are cut.
APPLICANT_CLAIM = re.compile(r"\b(my|i have|i ve|i m familiar|i am familiar|i led|i worked|i built|i managed|as a|we worked|i bring)\b")


def is_motivation(question) -> bool:
    return bool(MOTIVATION.search(apply.normalise_question(question)))


def check_motivation(text: str, posting: str, company: str = "") -> str:
    """A motivation draft must be about this posting, not about any company,
    and only about the company: sentences about the applicant are cut, and
    so is a last sentence the length limit stopped halfway."""
    sentences = re.split(r"(?<=[.!?])\s+", text.strip())
    if sentences and not re.search(r"[.!?][\"')]*$", sentences[-1]):
        sentences = sentences[:-1]
    kept = [s for s in sentences if not APPLICANT_CLAIM.search(apply.normalise_question(s))]
    if kept and kept[0] != sentences[0]:
        # The opening sentence went: "I'm also drawn to..." would start the answer.
        first = re.sub(r"^(Additionally|Also),\s*", "", kept[0])
        first = re.sub(r"^(I'm|I am|I) also\b", r"\1", first)
        kept[0] = first[:1].upper() + first[1:]
    text = " ".join(kept)
    if not text:
        raise Refused("the draft was about you, not the company; add your own reasons")
    if GENERIC_PRAISE.search(text.lower()):
        raise Refused("the draft was generic praise, not something from the job posting")
    skip = _words(company) | GENERIC
    shared = {w for w in _words(text) & _words(posting) if len(w) >= 5} - skip
    if len(shared) < 2:
        raise Refused("the draft didn't say anything specific from the job posting")
    return text


# The user's resume, as text. /apply reads the file in the browser and sends
# only its text; the file never reaches us. Saved only after the user ticks
# the box agreeing to the privacy policy, and that consent is kept with it.
# The model gets the first RESUME_PROMPT characters as facts (ai_answers).
RESUME = "#agent_resume#"
MAX_RESUME, RESUME_PROMPT = 8000, 6000
RESUME_TYPES = (".pdf", ".docx", ".md")
PRIVACY_VERSION = "2026-10-22"  # the privacy page that describes this; bump with its resume paragraph


def get_resume(table, user_id: str, agent_id: str = DEFAULT_ID) -> dict | None:
    return table.get_item(Key={"user_id": user_id, "alert_id": RESUME + agent_id}).get("Item")


def resume_view(row: dict | None) -> dict | None:
    """What /apply shows about it: never the text."""
    if not row:
        return None
    return {"name": row["name"], "chars": int(row["chars"]), "truncated": bool(row.get("truncated")), "uploaded_at": row["uploaded_at"]}


def put_resume(table, user_id: str, body: dict, now: datetime | None = None, agent_id: str = DEFAULT_ID) -> dict:
    now = now or datetime.now(timezone.utc)
    body = body if isinstance(body, dict) else {}
    if body.get("consent") is not True:
        raise ValueError("Agree to the privacy policy to add your resume")
    name = str(body.get("name") or "").strip()[:200]
    if not name.lower().endswith(RESUME_TYPES):
        raise ValueError("Add a PDF, DOCX or Markdown file")
    text = re.sub(r"[ \t]+", " ", re.sub(r"\n{3,}", "\n\n", str(body.get("text") or ""))).strip()
    if len(text) < 50:
        raise ValueError("No text could be read from that file")
    row = {"user_id": user_id, "alert_id": RESUME + agent_id, "name": name, "text": text[:MAX_RESUME], "chars": min(len(text), MAX_RESUME),
           "truncated": len(text) > MAX_RESUME, "uploaded_at": now.isoformat(), "consent_at": now.isoformat(),
           "consent_version": PRIVACY_VERSION}
    table.put_item(Item=row)
    return resume_view(row)


def delete_resume(table, user_id: str, agent_id: str = DEFAULT_ID) -> None:
    table.delete_item(Key={"user_id": user_id, "alert_id": RESUME + agent_id})
