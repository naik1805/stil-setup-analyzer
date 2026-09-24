"""RAM and GPU use for this dashboard process only (not the whole PC)."""

from __future__ import annotations

import os
import shutil
import subprocess
import threading


def _pids() -> set[int]:
    pids = {os.getpid()}
    try:
        import psutil

        for child in psutil.Process().children(recursive=True):
            pids.add(child.pid)
    except Exception:
        pass
    return pids


def _process_rss() -> int | None:
    try:
        import psutil

        proc = psutil.Process()
        rss = int(proc.memory_info().rss)
        for child in proc.children(recursive=True):
            try:
                rss += int(child.memory_info().rss)
            except Exception:
                continue
        return rss
    except Exception:
        pass
    try:
        import ctypes
        from ctypes import wintypes

        class PROCESS_MEMORY_COUNTERS_EX(ctypes.Structure):
            _fields_ = [
                ("cb", wintypes.DWORD),
                ("PageFaultCount", wintypes.DWORD),
                ("PeakWorkingSetSize", ctypes.c_size_t),
                ("WorkingSetSize", ctypes.c_size_t),
                ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                ("PagefileUsage", ctypes.c_size_t),
                ("PeakPagefileUsage", ctypes.c_size_t),
                ("PrivateUsage", ctypes.c_size_t),
            ]

        counters = PROCESS_MEMORY_COUNTERS_EX()
        counters.cb = ctypes.sizeof(PROCESS_MEMORY_COUNTERS_EX)
        handle = ctypes.windll.kernel32.GetCurrentProcess()
        if ctypes.windll.psapi.GetProcessMemoryInfo(handle, ctypes.byref(counters), counters.cb):
            return int(counters.WorkingSetSize)
    except Exception:
        return None
    return None


def _total_ram() -> int | None:
    try:
        import psutil

        return int(psutil.virtual_memory().total)
    except Exception:
        pass
    try:
        import ctypes

        class MEMORYSTATUSEX(ctypes.Structure):
            _fields_ = [
                ("dwLength", ctypes.c_ulong),
                ("dwMemoryLoad", ctypes.c_ulong),
                ("ullTotalPhys", ctypes.c_ulonglong),
                ("ullAvailPhys", ctypes.c_ulonglong),
                ("ullTotalPageFile", ctypes.c_ulonglong),
                ("ullAvailPageFile", ctypes.c_ulonglong),
                ("ullTotalVirtual", ctypes.c_ulonglong),
                ("ullAvailVirtual", ctypes.c_ulonglong),
                ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
            ]

        stat = MEMORYSTATUSEX()
        stat.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat)):
            return int(stat.ullTotalPhys)
    except Exception:
        return None
    return None


def _ram_for_project() -> tuple[float | None, int | None]:
    rss = _process_rss()
    total = _total_ram()
    if rss is None or not total:
        return None, rss
    return round(100.0 * rss / total, 1), rss


def _smi(*args: str) -> str | None:
    exe = shutil.which("nvidia-smi")
    if not exe:
        return None
    try:
        return subprocess.check_output(
            [exe, *args],
            timeout=3,
            stderr=subprocess.DEVNULL,
            text=True,
        )
    except Exception:
        return None


def _gpu_for_project(pids: set[int]) -> tuple[float | None, float]:
    if not shutil.which("nvidia-smi"):
        return None, 0.0

    sm_vals: list[float] = []
    pmon = _smi("pmon", "-c", "1", "-s", "um")
    if pmon:
        for line in pmon.splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split()
            if len(parts) < 4 or parts[1] in {"-", "?"}:
                continue
            try:
                pid = int(parts[1])
            except ValueError:
                continue
            if pid not in pids:
                continue
            sm = parts[3]
            if sm not in {"-", "?"}:
                try:
                    sm_vals.append(float(sm))
                except ValueError:
                    pass

    used_mib = 0.0
    apps = _smi("--query-compute-apps=pid,used_gpu_memory", "--format=csv,noheader,nounits")
    if apps:
        for line in apps.splitlines():
            parts = [p.strip() for p in line.split(",")]
            if len(parts) < 2:
                continue
            try:
                pid = int(parts[0])
                mem = float(parts[1])
            except ValueError:
                continue
            if pid in pids:
                used_mib += mem

    if sm_vals:
        return round(max(sm_vals), 1), used_mib
    return 0.0, used_mib


def _torch_cuda() -> tuple[bool, float]:
    try:
        import torch

        if not torch.cuda.is_available() or not torch.cuda.is_initialized():
            return False, 0.0
        reserved = float(torch.cuda.memory_reserved(0)) / (1024 * 1024)
        return True, reserved
    except Exception:
        return False, 0.0


def _gpu_device_pct() -> float | None:
    out = _smi("--query-gpu=utilization.gpu", "--format=csv,noheader,nounits")
    if not out:
        return None
    vals = []
    for line in out.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            vals.append(float(line.split(",")[0].strip()))
        except ValueError:
            continue
    return round(max(vals), 1) if vals else None


def system_util(*, job: bool = False) -> dict:
    ram, rss = _ram_for_project()
    gpu, smi_vram = _gpu_for_project(_pids())
    cuda_on, torch_vram = _torch_cuda()
    vram = max(smi_vram, torch_vram)
    if job:
        dev = _gpu_device_pct()
        if dev is not None:
            gpu = max(gpu or 0.0, dev)
    mb = None if rss is None else round(rss / (1024 * 1024), 1)
    if cuda_on or vram > 0:
        if gpu and gpu > 0:
            detail = f"{mb:.0f} MB RAM this process. GPU kernels running now."
        else:
            detail = f"{mb:.0f} MB RAM this process. GPU 0% = CUDA idle after the job."
    else:
        detail = f"{mb:.0f} MB RAM this process." if mb is not None else ""
    return {
        "ram_pct": ram,
        "gpu_pct": gpu,
        "gpu_note": "",
        "ram_mb": mb,
        "pid": os.getpid(),
        "ram_label": "n/a" if ram is None else f"{ram:.1f}%",
        "gpu_label": "n/a" if gpu is None else f"{gpu:.1f}%",
        "detail": detail,
    }


class HwRecorder:
    """Sample this process while a job runs and keep the peak RAM/GPU %."""

    def __init__(self, interval: float = 0.08):
        self.interval = interval
        self.peak = {"ram_pct": 0.0, "gpu_pct": 0.0, "ram_mb": 0.0}
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def __enter__(self) -> "HwRecorder":
        self._stop.clear()
        self._sample()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()
        return self

    def __exit__(self, *exc) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2)
        self._sample()

    def _run(self) -> None:
        while not self._stop.wait(self.interval):
            self._sample()

    def _sample(self) -> None:
        u = system_util(job=True)
        ram = float(u.get("ram_pct") or 0)
        gpu = float(u.get("gpu_pct") or 0)
        mb = float(u.get("ram_mb") or 0)
        if ram > self.peak["ram_pct"]:
            self.peak["ram_pct"] = ram
        if gpu > self.peak["gpu_pct"]:
            self.peak["gpu_pct"] = gpu
        if mb > self.peak["ram_mb"]:
            self.peak["ram_mb"] = mb

    def snapshot(self) -> dict:
        return {
            "ram_pct": round(self.peak["ram_pct"], 1),
            "gpu_pct": round(self.peak["gpu_pct"], 1),
            "ram_mb": round(self.peak["ram_mb"], 1),
        }
