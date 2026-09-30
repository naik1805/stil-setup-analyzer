"""Build ScanShift and MBIST STILs that reuse each partition's TEST_SETUP."""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MARKER = "// ----- STUCK-AT PAYLOAD"

SCANSHIFT_TAIL = """  // ----- SCAN_SHIFT PAYLOAD for this partition -----
  Ann {* scan_shift: shift chains after the same iJTAG TEST_SETUP *}
  Ann {* "cycle_number:1600 vector_type:SCAN_SHIFT" *}
  V { "SE"=1; "CLK"=1; "RESET"=1; "TMS"=0; "TCK"=0; }
  Ann {* "cycle_number:1601 vector_type:SCAN_SHIFT" *}
  V { "SE"=1; "CLK"=1; "RESET"=1; }
  Ann {* "cycle_number:1602 vector_type:SCAN_SHIFT" *}
  V { "SE"=0; "CLK"=0; "RESET"=1; }
}
"""

MBIST_TAIL = """  // ----- MBIST PAYLOAD for this partition -----
  Ann {* mbist: memory BIST after the same iJTAG TEST_SETUP *}
  Ann {* "cycle_number:1600 vector_type:MBIST" *}
  V { "SE"=0; "CLK"=1; "RESET"=1; "TMS"=0; "TCK"=0; }
  Ann {* "cycle_number:1601 vector_type:MBIST" *}
  V { "SE"=0; "CLK"=1; "RESET"=1; }
}
"""

KINDS = (
    ("scanshift", "SCAN_SHIFT", "scan_shift", "scanshift", "15", SCANSHIFT_TAIL),
    ("mbist", "MBIST", "mbist", "mbist", "7", MBIST_TAIL),
)


def main() -> None:
    n = 0
    for src in sorted(ROOT.glob("IJTAG_dft_part_*_stuck_1000pat.stil")):
        text = src.read_text(encoding="utf-8", errors="replace")
        if MARKER not in text:
            raise SystemExit(f"no payload marker in {src.name}")
        head = text.split(MARKER, 1)[0]
        part = src.stem.split("_")[3]
        for suffix, ttype, fault, title_bit, pend, tail in KINDS:
            out = head.replace("IJTAG_SCAN_TEST", ttype, 1)
            out = out.replace("fault_model       = stuck", f"fault_model       = {fault}", 1)
            out = out.replace("pattern_end     = 999", f"pattern_end     = {pend}", 1)
            out = out.replace("_stuck_at_ijtag", f"_{title_bit}_ijtag", 1)
            dest = ROOT / f"IJTAG_dft_part_{part}_{suffix}.stil"
            dest.write_text(out + tail, encoding="utf-8")
            print(dest.name, dest.stat().st_size)
            n += 1
    print("wrote", n)


if __name__ == "__main__":
    main()
