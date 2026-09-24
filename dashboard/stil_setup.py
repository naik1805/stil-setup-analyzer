"""Extract test-setup structure from an IEEE 1450 STIL file."""

from __future__ import annotations

import hashlib
import re
from pathlib import Path

from optimize_setup import extract_setup_cycles
from cuda_job import cuda_analyze_file, cuda_compare_files, encode_pin_matrix

TOP_BLOCKS = (
    "Header",
    "Signals",
    "SignalGroups",
    "Timing",
    "ScanStructures",
    "MacroDefs",
    "Procedures",
    "Spec",
    "Selector",
    "PatternBurst",
    "PatternExec",
    "Pattern",
    "Include",
    "Variables",
    "Environment",
)

RESET_PIN_RE = re.compile(
    r'\b(RESETN|RESET|TRSTN|TRST|PORB|POR_N|SCAN_RST|DDR_RESETN|SDIO_RST_n|IO3_RST)\b',
    re.I,
)
HEADER_FIELD_RE = re.compile(
    r'(Title|Date|Source)\s+"([^"]*)"',
    re.I,
)
ANN_KV_RE = re.compile(
    r"(tcd_signature|test_set_type|one_setup|no_initialization|pattern_begin|"
    r"pattern_end|fault_model|serial_flag|edt_external|dft_partition|"
    r"ijtag_sib_select|ijtag_tdr|scan_partition|edt_mode|edt_block)\s*=\s*(\S+)",
    re.I,
)
VECTOR_TYPE_RE = re.compile(r'vector_type:([A-Z_]+)')
PATTERN_NUM_RE = re.compile(r"pattern_numer:(\d+)")
PATTERN_DECL_RE = re.compile(r"^Pattern\s+(\w+)")
PROC_DECL_RE = re.compile(r"Procedure\s+(\w+)")
PI_RE = re.compile(r"_\s*pi_\s*=\s*([01X]+)")
BIDI_RE = re.compile(r"_\s*bidi_\s*=\s*([01XHLZ]+)")


def _event(key: str, label: str) -> dict:
    return {"id": key, "label": label}


def analyze_stil(path: Path, raw: str | None = None) -> dict:
    if raw is None:
        text = path.read_text(encoding="utf-8", errors="replace")
        name = path.name
        size = path.stat().st_size
    else:
        text = raw
        name = path.name if path else "upload.stil"
        size = len(raw.encode("utf-8", errors="replace"))

    digest = hashlib.md5(text.encode("utf-8", errors="replace")).hexdigest()
    header: dict[str, str] = {}
    for m in HEADER_FIELD_RE.finditer(text[:8000]):
        header[m.group(1).lower()] = m.group(2)
    for m in ANN_KV_RE.finditer(text[:12000]):
        header[m.group(1).lower()] = m.group(2)

    blocks = ["STIL"] if text.lstrip().startswith("STIL") else []
    for blk in TOP_BLOCKS:
        if re.search(rf"^{blk}\b", text, re.M):
            blocks.append(blk)

    reset_pins = sorted(set(RESET_PIN_RE.findall(text[:20000])), key=str.upper)

    procedures: list[dict] = []
    for m in PROC_DECL_RE.finditer(text):
        start = m.end()
        chunk = text[start : start + 2500]
        waits = [int(x) for x in re.findall(r"WaitCycles\s+(\d+)", chunk)]
        procedures.append(
            {
                "name": m.group(1),
                "wait_cycles": sum(waits),
                "has_porb": "PORB" in chunk,
                "has_trst": bool(re.search(r"\bTRST\b", chunk)),
                "has_resetn": "RESETN" in chunk,
                "has_tms_tlr": bool(re.search(r"TMS\s*=\s*1", chunk) and "Repeat 5" in chunk),
                "has_scan_flush": "flush scan" in chunk.lower() or "SE=1" in chunk,
            }
        )

    patterns = PATTERN_DECL_RE.findall(text)

    vector_counts: dict[str, int] = {}
    for m in VECTOR_TYPE_RE.finditer(text):
        vector_counts[m.group(1)] = vector_counts.get(m.group(1), 0) + 1

    pat_nums = [int(x) for x in PATTERN_NUM_RE.findall(text)]
    pattern_span = {"min": min(pat_nums), "max": max(pat_nums)} if pat_nums else None

    pi_values = PI_RE.findall(text[:80000])
    pi_unique = sorted(set(pi_values))
    bidi_heads = BIDI_RE.findall(text[:80000])

    notes: list[str] = []
    events: list[dict] = []
    seen: set[str] = set()

    def add(key: str, label: str) -> None:
        if key not in seen:
            seen.add(key)
            events.append(_event(key, label))

    low = text[:120000].lower()
    if any(p.upper() == "RESETN" for p in reset_pins):
        if pi_unique == ["01100000"] or (
            pi_unique and all(len(v) >= 3 and v[2] == "1" for v in pi_unique)
        ):
            add("resetn_hold_1", "Hold RESETN=1 (functional reset off)")
        if re.search(r"RESETN\s*=\s*0", text[:50000]):
            add("resetn_assert", "Assert RESETN (chip reset)")
        if re.search(r"RESETN\s*=\s*1", text[:50000]) and "resetn_assert" in seen:
            add("resetn_release", "Release RESETN")
        elif not pi_unique and re.search(r"RESETN\s*=\s*1", text[:50000]) and "resetn_assert" not in seen:
            add("resetn_hold_1", "Hold RESETN=1 (functional reset off)")
    if re.search(r'"RESET"\s*=\s*0', text[:40000]):
        add("reset_assert", "Assert RESET (top reset portion)")
    if re.search(r'"RESET"\s*=\s*1', text[:40000]) and "reset_assert" in seen:
        add("reset_release", "Release RESET after TAP idle")
    if header.get("dft_partition"):
        notes.append(f"dft_partition={header['dft_partition']}")

    trstn_bits = []
    for h in bidi_heads:
        if len(h) >= 2:
            trstn_bits.append(h[1])
    if "0" in trstn_bits and "1" in trstn_bits:
        add("trstn_pulse", "Pulse TRSTN / TAP reset pin")
    elif "TRSTN" in [p.upper() for p in reset_pins] or "TRST" in [p.upper() for p in reset_pins]:
        if re.search(r"TRST\s*=\s*0", text[:30000]):
            add("trstn_pulse", "Pulse TRST (TAP reset pin)")

    if "porb=0" in low:
        add("porb_assert", "Assert PORB (power-on reset)")
    if "porb=1" in low:
        add("porb_release", "Release PORB")

    if "tap controller reset" in low or "test-logic-reset" in low:
        add("tap_tlr", "TAP Test-Logic-Reset")
        notes.append("TAP controller reset annotated")
    if re.search(r"Repeat\s+5|Loop 5", text[:30000]) and "TMS" in text[:30000]:
        add("tms_tlr", "TAP reset via 5× TMS=1")
    if "ijtag" in low or "ieee 1687" in low or "sib[" in low:
        add("ijtag_select", "iJTAG (IEEE 1687) SIB/TDR partition select")

    if "advance tap controller to idle" in low or "run-test/idle" in low:
        add("tap_idle", "Advance TAP to idle")
    if "icall init" in low or "finished init sequence" in low:
        add("init_loop", "iCall init loop")
    if "shift-ir" in low:
        add("shift_ir", "Shift-IR (load TAP instruction)")
    if "shift-dr" in low or "tdr" in low:
        add("shift_dr", "Shift-DR / program TDR")
    if "edt_int_slow" in low or "edt_setup" in low:
        add("edt_enable", "Enable EDT compressed scan (edt_int_slow)")
    if re.search(r"lock occ|occ / pll|at-speed capture|pll for at-speed", low):
        add("pll_lock", "PLL / OCC lock (at-speed tail)")
    if "iddq" in low:
        add("iddq_settle", "IDDQ / cell-aware settle tail")
    if "flush scan" in low or "scan_reset_all_chains" in low or "scan_flush" in low:
        add("scan_flush", "Scan-flush chains to a known 0")
    if "wo_reset" in low:
        notes.append("ATPG mode wo_reset — functional RESETN not used as init")
    if header.get("one_setup", "").upper() == "ON":
        notes.append("one_setup=ON — setup intended once per mode")

    setup_ann_count = vector_counts.get("TEST_SETUP", 0)
    setup_cycle_rows = extract_setup_cycles(text)
    setup_pin_matrix = encode_pin_matrix(setup_cycle_rows)
    setup_expanded = len(setup_cycle_rows)
    setup_cycles = setup_expanded or setup_ann_count
    cuda_meta = cuda_analyze_file(text, setup_pin_matrix)
    if setup_cycles == 0 and procedures:
        setup_cycles = sum(p["wait_cycles"] for p in procedures)

    family = "unknown"
    blob = (header.get("title", "") + name).upper()
    if "MY_TOP" in blob or "MY_DES" in text[:4000] or "EDT_SCAN_TEST" in text[:4000]:
        family = "MY_TOP"
    if "DUT_TOP" in blob or "DUT_TOP" in text[:4000]:
        family = "DUT_TOP"
    if "IJTAG" in blob or "dft_part_" in text[:4000].lower() or header.get("test_set_type") == "IJTAG_SCAN_TEST":
        family = "IJTAG_DFT"

    setup_anns: list[str] = []
    for m in re.finditer(r"Ann \{\*\s*([^*]+?)\s*\*\}", text[:100000]):
        s = " ".join(m.group(1).split())
        if any(
            k in s.lower()
            for k in (
                "tap",
                "init",
                "shift",
                "reset",
                "edt",
                "pll",
                "iddq",
                "por",
                "test_setup",
            )
        ):
            if s not in setup_anns and len(setup_anns) < 24:
                setup_anns.append(s[:160])

    chains = re.findall(r"ScanChain\s+(\S+)", text)
    sib = header.get("ijtag_sib_select", "")
    open_sib = ""
    if sib and set(sib) <= set("01"):
        open_sib = ",".join(f"SIB[{i}]" for i, b in enumerate(sib) if b == "1") or "none"

    return {
        "file": name,
        "size_bytes": size,
        "md5": digest,
        "family": family,
        "header": header,
        "blocks": blocks,
        "reset_pins": reset_pins,
        "procedures": procedures,
        "patterns": patterns,
        "scan_chains": chains,
        "open_sib": open_sib,
        "vector_counts": vector_counts,
        "pattern_span": pattern_span,
        "pi_values": pi_unique[:8],
        "setup_cycles": setup_cycles,
        "setup_ann_count": setup_ann_count,
        "setup_expanded": setup_expanded,
        "setup_pin_matrix": setup_pin_matrix,
        "cuda": cuda_meta,
        "setup_events": events,
        "setup_notes": notes,
        "setup_annotations": setup_anns,
        "has_test_setup_vectors": setup_cycles > 0 and "TEST_SETUP" in vector_counts,
        "has_procedure_setup": bool(procedures),
    }


def compare_reports(reports: list[dict]) -> dict:
    if not reports:
        return {"files": [], "shared_events": [], "matrix": [], "pairs": []}

    event_sets = []
    for r in reports:
        event_sets.append({e["id"]: e["label"] for e in r.get("setup_events", [])})

    keys = [set(s) for s in event_sets]
    shared_ids = set.intersection(*keys) if keys else set()
    union_ids = set.union(*keys) if keys else set()
    labels = {}
    for s in event_sets:
        labels.update(s)

    shared = [{"id": k, "label": labels[k]} for k in sorted(shared_ids)]
    unique = []
    for r, s in zip(reports, keys):
        only = sorted(s - shared_ids)
        unique.append(
            {
                "file": r["file"],
                "only": [{"id": k, "label": labels[k]} for k in only],
            }
        )

    names = [r["file"] for r in reports]
    matrix = []
    pairs = []
    for i, a in enumerate(keys):
        row = []
        for j, b in enumerate(keys):
            u = a | b
            pct = round(100.0 * len(a & b) / len(u), 1) if u else 100.0
            row.append(pct)
            if j > i:
                pairs.append(
                    {
                        "a": names[i],
                        "b": names[j],
                        "overlap_pct": pct,
                        "shared": sorted(a & b),
                        "only_a": sorted(a - b),
                        "only_b": sorted(b - a),
                    }
                )
        matrix.append(row)

    same_family = len({r.get("family") for r in reports}) == 1

    field_specs = [
        ("Partition", lambda r: r.get("header", {}).get("dft_partition") or r.get("header", {}).get("scan_partition") or "—"),
        ("iJTAG SIB bits", lambda r: r.get("header", {}).get("ijtag_sib_select") or "—"),
        ("Which SIB is open", lambda r: r.get("open_sib") or "—"),
        ("iJTAG TDR", lambda r: r.get("header", {}).get("ijtag_tdr") or "—"),
        ("Fault model", lambda r: r.get("header", {}).get("fault_model") or "—"),
        ("Test type", lambda r: r.get("header", {}).get("test_set_type") or "—"),
        ("one_setup", lambda r: r.get("header", {}).get("one_setup") or "—"),
        ("Pattern range", lambda r: (
            f"{r.get('header', {}).get('pattern_begin', '?')}-{r.get('header', {}).get('pattern_end', '?')}"
        )),
        ("Scan chains", lambda r: ", ".join(r.get("scan_chains") or []) or "—"),
        ("Setup clocks", lambda r: str(r.get("setup_expanded") or r.get("setup_cycles") or 0)),
        ("Reset pins", lambda r: ", ".join(r.get("reset_pins") or []) or "—"),
    ]
    common_rows = []
    diff_rows = []
    for label, fn in field_specs:
        vals = [fn(r) for r in reports]
        row = {"item": label, "values": vals, "same": len(set(vals)) == 1}
        if row["same"]:
            common_rows.append(row)
        else:
            diff_rows.append(row)

    return {
        "files": names,
        "cuda": cuda_compare_files([r.get("setup_pin_matrix") or [] for r in reports]),
        "shared_events": shared,
        "unique_events": unique,
        "all_events": [{"id": k, "label": labels[k]} for k in sorted(union_ids)],
        "matrix": matrix,
        "pairs": pairs,
        "shared_count": len(shared_ids),
        "union_count": len(union_ids),
        "overlap_pct": round(100.0 * len(shared_ids) / len(union_ids), 1) if union_ids else 0,
        "same_family": same_family,
        "common_rows": common_rows,
        "diff_rows": diff_rows,
        "tester_hint": _plain_hint(reports, shared_ids, same_family, diff_rows),
    }


def _plain_hint(reports, shared_ids, same_family, diff_rows) -> str:
    if len(reports) < 2:
        return "Select two or more STIL files, then click Analyze setup."
    if not same_family:
        return "These files are not the same kit. Reset/setup protocol may not be reusable."
    if diff_rows:
        items = ", ".join(r["item"] for r in diff_rows)
        return (
            "COMMON: the reset and iJTAG *steps* (what is done). "
            "NOT COMMON: " + items + " (which partition is selected)."
        )
    return "These files use the same setup steps and the same partition settings."


def _tester_hint(reports: list[dict], shared_ids: set[str], same_family: bool) -> str:
    return _plain_hint(reports, shared_ids, same_family, [])
