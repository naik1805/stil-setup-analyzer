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

Uses CPU GBC on hosts without a GPU. CUDA is used automatically when available.

Deploy on Render: after this repo is on GitHub, open

`https://render.com/deploy?repo=<this-repo-url>`
