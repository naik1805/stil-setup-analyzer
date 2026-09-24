"""Label TEST_SETUP clocks as kept vs waste. Cut only duplicate / dual-reset / extra idle."""

from __future__ import annotations

import base64
import io
import re
import zipfile
from pathlib import Path

PIN_RE = re.compile(r'"([^"]+)"\s*=\s*([01LHXZ])')


def extract_setup_region(text: str) -> str:
    start = text.find("Pattern ")
    if start < 0:
        start = 0
    payload = re.search(r"pattern_numer:|vector_type:LOAD_UNLOAD", text[start:])
    end = start + payload.start() if payload else len(text)
    return text[start:end]


def _pins(body: str) -> dict[str, str]:
    return {m.group(1): m.group(2) for m in PIN_RE.finditer(body)}


def _phase_from_ann(ann: str, current: str) -> str:
    a = ann.lower()
    if "sib[" in a or "sib network" in a:
        return "sib"
    if "tdr" in a:
        return "tdr"
    if "shift-ir" in a or "ieee1687 access" in a:
        return "ir"
    if "exit-ir" in a:
        return "exit_ir"
    if "ijtag done" in a or "exit-dr" in a:
        return "exit_dr"
    if "test-logic-reset" in a:
        return "tms_tlr"
    if "release trst" in a:
        return "trst_release"
    if "release reset" in a:
        return "reset_release"
    if "assert reset" in a or "reset_portion: assert" in a:
        return "reset_assert"
    return current


def extract_setup_cycles(text: str) -> list[dict]:
    """Walk setup text. Expand Loop N. Carry the last Ann phase onto following vectors."""
    region = extract_setup_region(text)
    cycles: list[dict] = []
    phase = "other"
    pending_loop = 1
    i = 0
    n = len(region)

    while i < n:
        rest = region[i:]
        if rest.lstrip().startswith("Loop"):
            m = re.match(r"\s*Loop\s+(\d+)\s*\{", rest)
            if m:
                pending_loop = int(m.group(1))
                i += m.end()
                continue
        if rest.lstrip().startswith("Ann"):
            m = re.match(r"\s*Ann\s*\{\*\s*(.*?)\s*\*\}", rest, re.S)
            if m:
                phase = _phase_from_ann(m.group(1), phase)
                i += m.end()
                continue
        vm = re.match(r"\s*V\s*\{([^}]*)\}", rest)
        if vm:
            pins = _pins(vm.group(1))
            times = max(1, pending_loop)
            for k in range(times):
                cycles.append(
                    {
                        "index": len(cycles),
                        "pins": pins,
                        "phase": phase,
                        "loop": times,
                        "loop_i": k,
                    }
                )
            pending_loop = 1
            i += vm.end()
            continue
        if rest[:1] == "}":
            pending_loop = 1
            i += 1
            continue
        i += 1
    return cycles


def classify_cycles(cycles: list[dict]) -> list[dict]:
    out = []
    seen_reset_assert = False
    tap_reset_done = False
    reset_released = False
    idle_hold_used = False

    for i, c in enumerate(cycles):
        phase = c.get("phase") or "other"
        pins = c.get("pins", {})
        prev = cycles[i - 1]["pins"] if i else {}
        duplicate = bool(prev) and pins == prev
        feat_tap_done = tap_reset_done
        feat_reset_rel = reset_released

        # Pin-based fallback when Ann phase is still generic.
        if phase == "other":
            if pins.get("RESET") == "0" and pins.get("TRST") == "0":
                phase = "reset_assert"
            elif pins.get("RESET") == "0" and pins.get("TRST") == "1":
                phase = "trst_release"
            elif c.get("loop", 1) > 1 and pins.get("TMS") == "1":
                phase = "tms_tlr"

        decision = "keep"
        label = ""
        reason = ""

        if phase == "reset_assert":
            if seen_reset_assert or duplicate:
                decision = "waste"
                label = "Duplicate RESET/TRST hold"
                reason = (
                    "CUT: pins are identical to the previous clock (RESET=0, TRST=0, TCK=0). "
                    "The chip is already in reset. Repeating the same levels does not create a new reset edge."
                )
            else:
                seen_reset_assert = True
                label = "Assert RESET and TRST"
                reason = (
                    "KEEP: at power-up the chip and TAP state are unknown. "
                    "If RESET stays 1, scan flops are not forced to a known start and every later pattern is invalid."
                )
        elif phase == "trst_release":
            tap_reset_done = True
            label = "Release TRST"
            reason = (
                "KEEP: IEEE 1149.1 TAP reset is this TRST 0-to-1 edge. "
                "Without it the TAP may not be in Test-Logic-Reset, so Shift-IR later loads into the wrong state."
            )
        elif phase == "tms_tlr":
            if tap_reset_done:
                decision = "waste"
                label = "Second TAP reset (5x TMS=1)"
                reason = (
                    "CUT: IEEE 1149.1 needs ONE TAP reset — either TRST or TMS=1 for 5 TCK. "
                    "TRST already did it. These 5 clocks reset a TAP that is already reset. Zero new effect."
                )
            else:
                tap_reset_done = True
                label = "TAP reset via 5x TMS=1"
                reason = (
                    "KEEP: no TRST reset happened, so these 5 TMS=1 clocks are the only legal TAP reset. "
                    "Cut them and the TAP is not in Test-Logic-Reset."
                )
        elif phase == "reset_release":
            if reset_released and pins.get("TCK") == "0":
                decision = "waste"
                label = "Extra idle after RESET release"
                reason = (
                    "CUT: RESET is already 1 and TMS is already 0 from the previous clock. "
                    "This TCK=0 hold does not enter a new TAP state and does not open any SIB."
                )
            else:
                reset_released = True
                label = "Release RESET, go toward idle"
                reason = (
                    "KEEP: scan shift cannot run while RESET=0 — the chip stays in reset and ignores SE/scan_in. "
                    "This is the clock that actually enables the DUT for iJTAG and patterns."
                )
        elif phase == "ir":
            label = "Shift-IR (iJTAG instruction)"
            reason = (
                "KEEP: these TDI bits are the TAP instruction that connects TDI/TDO to the iJTAG network. "
                "Cut any bit and the decoder never selects IEEE 1687 — SIB/TDR shifts go nowhere."
            )
        elif phase == "exit_ir":
            label = "Exit-IR to idle"
            reason = (
                "KEEP: the instruction sits in the shift register until Update-IR (leave Shift-IR). "
                "Stay in Shift-IR and iJTAG is never selected, even if the IR bits were correct."
            )
        elif phase == "sib":
            label = "Shift-DR SIB (pick the partition)"
            reason = (
                "KEEP: each SIB bit is a door. These 5 bits open exactly one dft_part. "
                "Drop a bit and you test the wrong partition or no partition. Values differ per file."
            )
        elif phase == "tdr":
            label = "Shift-DR TDR (configure that partition)"
            reason = (
                "KEEP: the TDR behind the open SIB turns that partition's scan/EDT path on. "
                "Cut it and the SIB is open but the island is not configured — payload has no target."
            )
        elif phase == "exit_dr":
            if pins.get("TCK") == "0" and idle_hold_used:
                decision = "waste"
                label = "Extra idle after iJTAG"
                reason = (
                    "CUT: Update-DR already happened. Another TCK=0 idle does not latch SIB/TDR again."
                )
            else:
                if pins.get("TCK") == "0":
                    idle_hold_used = True
                label = "Exit-DR to idle"
                reason = (
                    "KEEP: SIB/TDR values latch on Update-DR when you leave Shift-DR. "
                    "Skip this and the partition select is shifted but never applied."
                )
        else:
            if duplicate:
                decision = "waste"
                label = "Duplicate hold"
                reason = (
                    "CUT: every pin matches the previous clock. No TAP transition and no new data bit."
                )
            else:
                label = "Setup clock"
                reason = "KEEP: pins changed, so this clock is a real protocol step."

        row = dict(c)
        row["phase"] = phase
        row["rule_hint"] = decision
        row["decision"] = decision
        row["label"] = label
        row["reason"] = reason
        row["meaning"] = _teach(phase, row, i, pins)
        row["pins_text"] = " ".join(f"{k}={v}" for k, v in pins.items())
        row["protected"] = (
            phase in {"ir", "sib", "tdr", "exit_ir", "trst_release"}
            or (phase == "exit_dr" and decision == "keep")
            or (phase == "reset_assert" and decision == "keep")
        )
        row["features"] = {
            "duplicate": int(duplicate),
            "tap_already_reset": int(feat_tap_done),
            "reset_already_released": int(feat_reset_rel),
            "tck_zero": int(pins.get("TCK") == "0"),
            "tms_one": int(pins.get("TMS") == "1"),
            "is_sib": int(phase == "sib"),
            "is_tdr": int(phase == "tdr"),
            "is_ir": int(phase == "ir"),
            "is_exit": int(phase in ("exit_ir", "exit_dr")),
            "is_tms_tlr": int(phase == "tms_tlr"),
            "is_reset_assert": int(phase == "reset_assert"),
            "loop_repeat": int(c.get("loop", 1) > 1),
            "rule_says_cut": int(decision == "waste"),
        }
        out.append(row)
    return out


def _teach(phase: str, row: dict, index: int, pins: dict[str, str]) -> str:
    tdi = pins.get("TDI", "—")
    if phase == "reset_assert":
        if row["decision"] == "waste":
            return "Same reset levels as clock 0. The chip is already in reset. This clock does not start a new reset."
        return "Drive RESET=0 and TRST=0. Chip logic and the TAP start from a known reset, not a random power-up state."
    if phase == "trst_release":
        return "TRST goes 0 to 1. That edge is the IEEE 1149.1 TAP reset. After this, the TAP is in Test-Logic-Reset."
    if phase == "tms_tlr":
        n = row.get("loop_i", 0) + 1
        return (
            f"TMS=1 TAP-reset clock {n} of 5. IEEE 1149.1 uses five of these if TRST was not used. "
            "In this file TRST already reset the TAP, so this is a second reset."
        )
    if phase == "reset_release":
        if row["decision"] == "waste":
            return "RESET is already 1 and TMS is already 0. Extra idle. The chip is already out of reset."
        return "Release RESET (RESET=1) and drop TMS so the TAP can leave reset and move toward idle. Scan cannot run while RESET=0."
    if phase == "ir":
        return (
            f"Shift-IR bit. TDI={tdi} is one bit of the TAP instruction that selects the iJTAG network. "
            "All four IR clocks are required or iJTAG is never selected."
        )
    if phase == "exit_ir":
        if pins.get("TMS") == "1":
            return "Leave Shift-IR (TMS=1). The instruction moves toward Update-IR so it can take effect."
        return "Park the TAP toward idle after Update-IR. iJTAG is now the selected instruction."
    if phase == "sib":
        return (
            f"Shift-DR SIB bit. TDI={tdi} is one door on the 5-SIB network. "
            "Together these five bits open exactly one DFT partition."
        )
    if phase == "tdr":
        return (
            f"Shift-DR TDR bit. TDI={tdi} is one bit of the config register behind the open SIB. "
            "These eight bits turn that partition's scan path on."
        )
    if phase == "exit_dr":
        if pins.get("TMS") == "1":
            return "Leave Shift-DR (TMS=1). SIB and TDR values latch (Update-DR). The chosen partition becomes active."
        return "Return TAP to idle. Setup is done. The next clocks are the 1000 stuck-at patterns."
    return "A TEST_SETUP tester clock in the bring-up sequence."


def explain_setup(path: Path, raw: str | None = None) -> dict:
    text = raw if raw is not None else path.read_text(encoding="utf-8", errors="replace")
    name = path.name if path else "upload.stil"
    classified = classify_cycles(extract_setup_cycles(text))
    return {
        "file": name,
        "clock_count": len(classified),
        "cycles": [
            {
                "index": c["index"],
                "phase": c["phase"],
                "label": c["label"],
                "meaning": c.get("meaning") or c["reason"],
                "decision": c["decision"],
                "pins": c.get("pins_text") or "",
                "tdi": c.get("pins", {}).get("TDI", ""),
            }
            for c in classified
        ],
    }


def explain_many(items: list[dict]) -> dict:
    files = [explain_setup(item["path"], raw=item.get("text")) for item in items]
    first = files[0] if files else {"clock_count": 0, "cycles": [], "file": ""}
    return {
        "files": files,
        "guide": first,
        "note": (
            f"{first.get('file', '')} has {first.get('clock_count', 0)} tester clocks in TEST_SETUP. "
            "The other selected files use the same steps. Only SIB and TDR TDI bits differ."
        ),
    }


def summarize(classified: list[dict]) -> dict:
    kept = [c for c in classified if c["decision"] == "keep"]
    waste = [c for c in classified if c["decision"] == "waste"]

    def groups(rows: list[dict], decision: str) -> list[dict]:
        buckets: dict[str, dict] = {}
        for c in rows:
            key = c["label"]
            if key not in buckets:
                buckets[key] = {
                    "label": c["label"],
                    "reason": c["reason"],
                    "decision": decision,
                    "cycles": [],
                    "count": 0,
                }
            buckets[key]["cycles"].append(c["index"])
            buckets[key]["count"] += 1
        return list(buckets.values())

    before = len(classified)
    after = len(kept)
    written = sum(1 for c in classified if c.get("loop_i", 0) == 0)
    return {
        "before_clocks": before,
        "written_lines": written,
        "after_clocks": after,
        "cut_clocks": before - after,
        "kept": groups(kept, "keep"),
        "waste": groups(waste, "waste"),
        "cycles": [
            {
                "index": c["index"],
                "decision": c["decision"],
                "label": c["label"],
                "reason": c["reason"],
                "phase": c["phase"],
            }
            for c in classified
        ],
    }


def _fmt_pins(pins: dict[str, str]) -> str:
    return "; ".join(f'"{k}"={v}' for k, v in pins.items())


def emit_optimized_setup(classified: list[dict]) -> str:
    lines = [
        "  // ----- OPTIMIZED TEST_SETUP (waste clocks removed) -----",
        "  Ann {* optimized_setup: duplicate hold, second TAP reset, extra idle cut *}",
    ]
    n = 0
    last_phase = ""
    headers = {
        "reset_assert": "  Ann {* reset_portion: assert RESET and TRST *}",
        "trst_release": "  Ann {* reset_portion: release TRST, keep RESET asserted *}",
        "tms_tlr": "  Ann {* reset_portion: TAP Test-Logic-Reset via TMS=1 *}",
        "reset_release": "  Ann {* reset_portion: release RESET, TAP to idle *}",
        "ir": "  Ann {* + Shift-IR IEEE1687 access instruction *}",
        "exit_ir": "  Ann {* + Exit-IR to idle *}",
        "sib": "  Ann {* + iJTAG Shift-DR SIB network *}",
        "tdr": "  Ann {* + iJTAG TDR config *}",
        "exit_dr": "  Ann {* + iJTAG done *}",
    }
    for c in classified:
        if c["decision"] != "keep":
            continue
        phase = c.get("phase") or ""
        if phase != last_phase and phase in headers:
            lines.append(headers[phase])
            last_phase = phase
        lines.append(f'  Ann {{* "cycle_number:{n} vector_type:TEST_SETUP" *}}')
        lines.append(f'  V {{ {_fmt_pins(c["pins"])}; }}')
        n += 1
    lines.append("")
    return "\n".join(lines)


def rewrite_optimized(text: str, classified: list[dict]) -> str:
    start = re.search(r"(Pattern\s+\w+\s*\{\s*\n\s*W\s+\S+\s*;\s*\n)", text)
    end = re.search(r"\n\s*// ----- STUCK-AT PAYLOAD|\n\s*Ann \{\*\s*\"cycle_number:\d+\s+pattern_numer:", text)
    if not start or not end:
        return text
    return text[: start.end()] + emit_optimized_setup(classified) + text[end.start() + 1 :]


def optimized_name(name: str) -> str:
    if name.lower().endswith(".stil"):
        return name[:-5] + "_opt.stil"
    return name + "_opt.stil"


def summarize_ltd(classified: list[dict]) -> dict:
    keep = [c for c in classified if c.get("final") == "keep"]
    review = [c for c in classified if c.get("final") == "pending"]
    removed = [c for c in classified if c.get("final") == "remove"]

    def groups(rows: list[dict], decision: str) -> list[dict]:
        buckets: dict[str, dict] = {}
        for c in rows:
            key = c["label"]
            if key not in buckets:
                buckets[key] = {
                    "label": c["label"],
                    "reason": c.get("meaning") or c.get("reason"),
                    "decision": decision,
                    "ltd_action": c.get("ltd_action"),
                    "cycles": [],
                    "count": 0,
                    "p_cut": c.get("p_cut"),
                    "features": c.get("features"),
                }
            buckets[key]["cycles"].append(c["index"])
            buckets[key]["count"] += 1
        return list(buckets.values())

    def one_each(rows: list[dict], decision: str) -> list[dict]:
        items = []
        for c in sorted(rows, key=lambda x: x["index"]):
            items.append(
                {
                    "label": f"Clock {c['index']}: {c['label']}",
                    "reason": c.get("meaning") or c.get("reason"),
                    "decision": decision,
                    "ltd_action": c.get("ltd_action"),
                    "cycles": [c["index"]],
                    "count": 1,
                    "p_cut": c.get("p_cut"),
                    "features": c.get("features"),
                    "pins": c.get("pins_text") or "",
                }
            )
        return items

    return {
        "before_clocks": len(classified),
        "after_clocks": len(keep) + len(review),
        "cut_clocks": len(removed),
        "review_clocks": len(review),
        "kept": groups(keep, "keep"),
        "review": one_each(review, "review"),
        "removed": one_each(removed, "remove"),
        "cycles": [
            {
                "index": c["index"],
                "label": c["label"],
                "meaning": c.get("meaning"),
                "final": c.get("final"),
                "ltd_action": c.get("ltd_action"),
                "p_cut": c.get("p_cut"),
                "protected": c.get("protected"),
                "review_label": c.get("review_label"),
                "features": c.get("features"),
                "phase": c.get("phase"),
            }
            for c in classified
        ],
    }


def optimize_stil(path: Path, raw: str | None = None, classified: list[dict] | None = None) -> dict:
    from ltd_gbc import apply_ltd

    text = raw if raw is not None else path.read_text(encoding="utf-8", errors="replace")
    name = path.name if path else "upload.stil"
    if classified is None:
        classified = classify_cycles(extract_setup_cycles(text))
    classified, meta = apply_ltd(classified, name)
    for c in classified:
        c["decision"] = "waste" if c.get("final") == "remove" else "keep"
    summary = summarize_ltd(classified)
    summary["file"] = name
    summary["ltd"] = meta
    opt_text = rewrite_optimized(text, classified)
    summary["optimized_name"] = optimized_name(name)
    summary["optimized_text"] = opt_text
    return summary


def optimize_many(items: list[dict]) -> dict:
    from ltd_gbc import train_gbc

    prepared = []
    for item in items:
        path = item["path"]
        text = item.get("text")
        if text is None:
            text = path.read_text(encoding="utf-8", errors="replace")
        cls = classify_cycles(extract_setup_cycles(text))
        prepared.append({"path": path, "text": text, "classified": cls})
    train_gbc([p["classified"] for p in prepared])

    files = []
    for p in prepared:
        files.append(optimize_stil(p["path"], raw=p["text"], classified=p["classified"]))
    if not files:
        return {"files": [], "shared": {}}
    first = files[0]
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in files:
            zf.writestr(f["optimized_name"], f["optimized_text"])
    zip_b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    slim = []
    for f in files:
        slim.append({k: v for k, v in f.items() if k != "optimized_text"})
        slim[-1]["has_optimized"] = True
    from cuda_job import cuda_info

    return {
        "files": slim,
        "zip_name": "IJTAG_optimized_stils.zip",
        "zip_b64": zip_b64,
        "cuda": cuda_info(),
        "shared": {
            "before_clocks": first["before_clocks"],
            "after_clocks": first["after_clocks"],
            "cut_clocks": first["cut_clocks"],
            "review_clocks": first.get("review_clocks"),
            "kept": first["kept"],
            "review": first.get("review") or [],
            "removed": first.get("removed") or [],
            "ltd": first.get("ltd") or {},
            "same_for_all": all(f["before_clocks"] == first["before_clocks"] for f in files),
            "note": (
                f"CUDA GBC Learning-to-Defer scored {first['before_clocks']} tester clocks. "
                "Nothing is waste until you click Remove. SIB/TDR/IR stay Keep unless you override later."
            ),
        },
    }
