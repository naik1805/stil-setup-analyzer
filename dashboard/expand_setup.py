"""Expand kit TEST_SETUP to ~1600 tester clocks (worst-case-style island)."""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MARKER = "// ----- STUCK-AT PAYLOAD"
WFT = "  W WFT_50MHZ;"

IR_BITS = 32
SIB_BITS = 64
TDR_BITS = 1400
PLL_BITS = 90


def _sib64(part: int) -> str:
    bits = ["0"] * SIB_BITS
    bits[part] = "1"
    return "".join(bits)


def _tdr1400(tdr8: str) -> str:
    tdr8 = "".join(c for c in tdr8 if c in "01")
    tdr8 = (tdr8 + "00000000")[:8]
    return ("0" * (TDR_BITS - 8)) + tdr8


def _v(cycle: int, body: str) -> str:
    return (
        f'  Ann {{* "cycle_number:{cycle} vector_type:TEST_SETUP" *}}\n'
        f"  V {{ {body} }}\n"
    )


def build_setup(part: int, tdr8: str) -> str:
    sib = _sib64(part)
    tdr = _tdr1400(tdr8)
    n = 0
    out = ["  W WFT_50MHZ;\n", "  // ----- RESET PORTION (top) -----\n"]
    out.append("  Ann {* reset_portion: assert RESET and TRST *}\n")
    out.append(_v(n, '"RESET"=0; "TRST"=0; "TCK"=0; "TMS"=1; "TDI"=0; "SE"=0; "CLK"=0;'))
    n += 1
    out.append(_v(n, '"RESET"=0; "TRST"=0; "TCK"=0; "TMS"=1; "TDI"=0;'))
    n += 1
    out.append("  Ann {* reset_portion: release TRST, keep RESET asserted *}\n")
    out.append(_v(n, '"RESET"=0; "TRST"=1; "TMS"=1; "TCK"=1;'))
    n += 1
    out.append("  Ann {* reset_portion: TAP Test-Logic-Reset via TMS=1 *}\n")
    out.append("  Loop 5 {\n")
    out.append(_v(n, '"TMS"=1; "TCK"=1; "RESET"=0;'))
    n += 5
    out.append("  }\n")
    out.append("  Ann {* reset_portion: release RESET, TAP to idle *}\n")
    out.append(_v(n, '"RESET"=1; "TMS"=0; "TCK"=1; "TRST"=1;'))
    n += 1
    out.append(_v(n, '"RESET"=1; "TMS"=0; "TCK"=0;'))
    n += 1

    out.append(f"  // ----- iJTAG PORTION: select DFT partition dft_part_{part} -----\n")
    out.append(f"  Ann {{* IEEE 1687 iJTAG: target partition dft_part_{part} *}}\n")
    out.append("  Ann {* + Shift-IR IEEE1687 access instruction *}\n")
    ir = "1" + "0" * (IR_BITS - 1)
    for bit in ir:
        out.append(_v(n, f'"TMS"=0; "TDI"={bit}; "TCK"=1; "RESET"=1;'))
        n += 1
    out.append("  Ann {* + Exit-IR to idle *}\n")
    out.append(_v(n, '"TMS"=1; "TCK"=1; "RESET"=1;'))
    n += 1
    out.append(_v(n, '"TMS"=0; "TCK"=1; "RESET"=1;'))
    n += 1

    out.append(f"  Ann {{* + iJTAG Shift-DR SIB network: {SIB_BITS}-bit, open SIB[{part}] *}}\n")
    for i, bit in enumerate(sib):
        state = "OPEN" if bit == "1" else "CLOSED"
        out.append(f"  Ann {{* iJTAG SIB[{i}]={state} *}}\n")
        out.append(_v(n, f'"TMS"=0; "TDI"={bit}; "TDO"=L; "TCK"=1; "RESET"=1;'))
        n += 1

    out.append(f"  Ann {{* + iJTAG TDR config for dft_part_{part}, {TDR_BITS} bits *}}\n")
    for bit in tdr:
        out.append(_v(n, f'"TMS"=0; "TDI"={bit}; "TDO"=L; "TCK"=1; "RESET"=1;'))
        n += 1

    out.append(f"  Ann {{* + iJTAG done: scan partition dft_part_{part} is the only active DFT partition *}}\n")
    out.append(_v(n, '"TMS"=1; "TCK"=1; "RESET"=1; "SE"=0;'))
    n += 1
    out.append(_v(n, '"TMS"=0; "TCK"=0; "RESET"=1; "SE"=0;'))
    n += 1

    out.append("  Ann {* pll / occ lock and edt_int_slow tail after iJTAG *}\n")
    out.append(_v(n, '"RESET"=1; "TMS"=0; "TCK"=0; "SE"=0; "CLK"=1;'))
    n += 1
    for _ in range(PLL_BITS - 1):
        out.append(_v(n, '"RESET"=1; "TMS"=0; "TCK"=0; "SE"=0; "CLK"=1;'))
        n += 1

    return "".join(out), n, sib, tdr


def patch_header(text: str, sib: str, tdr: str) -> str:
    text = re.sub(r"(ijtag_sib_select\s*=\s*)\S+", r"\g<1>" + sib, text, count=1)
    text = re.sub(r"(ijtag_tdr\s*=\s*)\S+", r"\g<1>" + tdr, text, count=1)
    return text


def expand_stuck(path: Path) -> int:
    text = path.read_text(encoding="utf-8", errors="replace")
    if MARKER not in text or WFT not in text:
        raise SystemExit(f"unexpected layout: {path.name}")
    m = re.search(r"dft_partition\s*=\s*dft_part_(\d+)", text)
    tdr_m = re.search(r"ijtag_tdr\s*=\s*([01]+)", text)
    if not m or not tdr_m:
        raise SystemExit(f"missing partition/tdr: {path.name}")
    part = int(m.group(1))
    raw_tdr = tdr_m.group(1)
    tdr8 = raw_tdr[-8:] if len(raw_tdr) >= 8 else raw_tdr.ljust(8, "0")
    setup, n, sib, tdr = build_setup(part, tdr8)
    pre, _, rest = text.partition(WFT)
    _, _, payload = rest.partition(MARKER)
    new = patch_header(pre, sib, tdr) + setup + MARKER + payload
    path.write_text(new, encoding="utf-8")
    return n


def main() -> None:
    for src in sorted(ROOT.glob("IJTAG_dft_part_*_stuck_1000pat.stil")):
        n = expand_stuck(src)
        print(src.name, "setup_clocks", n, "bytes", src.stat().st_size)


if __name__ == "__main__":
    main()
