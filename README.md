# STIL test-setup analyzer

Web dashboard for IEEE 1450 STIL test-setup compare and Learning-to-Defer optimize.

## Local

```
cd dashboard
pip install -r requirements.txt
python server.py
```

Open http://127.0.0.1:8765

## Online

Live site: https://stil-setup-analyzer.onrender.com

Uses CPU GBC on hosts without a GPU. CUDA is used automatically when available.

Repo: https://github.com/naik1805/stil-setup-analyzer

One-click host on Render (free CPU plan):

https://render.com/deploy?repo=https://github.com/naik1805/stil-setup-analyzer

Kit files on the live service: five `IJTAG_dft_part_*_stuck_1000pat.stil` (~1600 TEST_SETUP clocks each) plus ScanShift and MBIST for the same partitions. Analyze compares common vs different setup. SIB is the 64-bit select network; TDR is the 1400-bit config register. Engineer review is Keep / Reject.
