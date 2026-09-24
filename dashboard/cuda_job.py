"""STIL analyze/compare tensor work. Uses CUDA when present, otherwise CPU."""

from __future__ import annotations

import math
from collections import Counter

PIN_ORDER = ("TCK", "TMS", "TDI", "TDO", "TRST", "RESET")


def _torch():
    try:
        import torch

        return torch
    except Exception:
        return None


def cuda_info() -> dict:
    torch = _torch()
    if torch is not None and torch.cuda.is_available():
        return {
            "ok": True,
            "device": torch.cuda.get_device_name(0),
            "backend": "cuda",
        }
    return {"ok": False, "device": "cpu", "backend": "cpu"}


def encode_pin_matrix(cycles: list[dict]) -> list[list[int]]:
    rows = []
    for c in cycles:
        pins = c.get("pins") or {}
        rows.append([1 if pins.get(p) == "1" else 0 for p in PIN_ORDER])
    return rows


def _cpu_analyze_file(text: str, pin_matrix: list[list[int]]) -> dict:
    raw = text.encode("utf-8", errors="replace")
    entropy = 0.0
    if raw:
        counts = Counter(raw)
        n = float(len(raw))
        entropy = -sum((c / n) * math.log(c / n) for c in counts.values())
    transitions = 0
    if pin_matrix and len(pin_matrix) > 1:
        transitions = sum(1 for a, b in zip(pin_matrix, pin_matrix[1:]) if a != b)
    return {
        "ok": True,
        "backend": "cpu",
        "device": "cpu",
        "entropy": round(entropy, 4),
        "texture": 0.0,
        "pin_transitions": int(transitions),
    }


def cuda_analyze_file(text: str, pin_matrix: list[list[int]]) -> dict:
    torch = _torch()
    if torch is None or not torch.cuda.is_available():
        return _cpu_analyze_file(text, pin_matrix)
    import numpy as np

    raw = np.frombuffer(text.encode("utf-8", errors="replace"), dtype=np.uint8).copy()
    data = torch.as_tensor(raw, device="cuda", dtype=torch.int64)
    hist = torch.bincount(data, minlength=256).to(torch.float32)
    hist = hist / hist.sum().clamp_min(1.0)
    entropy = float(-(hist * (hist + 1e-12).log()).sum().item())
    transitions = 0.0
    if pin_matrix:
        pins = torch.as_tensor(pin_matrix, device="cuda", dtype=torch.float32)
        if pins.shape[0] > 1:
            transitions = float((pins[1:] != pins[:-1]).any(dim=1).sum().item())
    if data.numel() >= 8:
        win = data.unfold(0, 8, 8)
        weights = torch.tensor([3**i for i in range(8)], device="cuda", dtype=torch.int64)
        sig = (win * weights).sum(1) % 4096
        grams = torch.bincount(sig, minlength=4096).to(torch.float32)
        grams = grams / grams.sum().clamp_min(1.0)
        texture = float((grams * grams).sum().item())
    else:
        texture = 0.0
    torch.cuda.synchronize()
    return {
        "ok": True,
        "backend": "cuda",
        "device": torch.cuda.get_device_name(0),
        "entropy": round(entropy, 4),
        "texture": round(texture, 6),
        "pin_transitions": int(transitions),
    }


def cuda_compare_files(matrices: list[list[list[int]]]) -> dict:
    torch = _torch()
    if torch is None or not torch.cuda.is_available():
        scores = []
        for i, a in enumerate(matrices):
            if not a:
                continue
            for j, b in enumerate(matrices):
                if j <= i or not b:
                    continue
                n = min(len(a), len(b))
                if n == 0:
                    continue
                same = sum(1 for k in range(n) if a[k] == b[k]) / n
                scores.append(same)
        return {
            "ok": True,
            "backend": "cpu",
            "device": "cpu",
            "cycle_match_pct": round(100.0 * (sum(scores) / len(scores)), 1) if scores else None,
        }
    scores = []
    for i, a in enumerate(matrices):
        if not a:
            continue
        ta = torch.as_tensor(a, device="cuda", dtype=torch.float32)
        for j, b in enumerate(matrices):
            if j <= i or not b:
                continue
            tb = torch.as_tensor(b, device="cuda", dtype=torch.float32)
            n = min(ta.shape[0], tb.shape[0])
            if n == 0:
                continue
            same = (ta[:n] == tb[:n]).all(dim=1).float().mean()
            scores.append(float(same.item()))
    torch.cuda.synchronize()
    return {
        "ok": True,
        "backend": "cuda",
        "device": torch.cuda.get_device_name(0),
        "cycle_match_pct": round(100.0 * (sum(scores) / len(scores)), 1) if scores else None,
    }
