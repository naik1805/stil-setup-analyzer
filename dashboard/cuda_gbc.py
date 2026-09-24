"""Gradient boosting classifier trained and scored on CUDA."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import torch


def cuda_device() -> torch.device:
    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is not available")
    return torch.device("cuda")


def gpu_name() -> str:
    return torch.cuda.get_device_name(0) if torch.cuda.is_available() else "cpu"


class CudaGBC:
    """Logistic gradient boosting. Same role as sklearn GradientBoostingClassifier."""

    def __init__(self, n_estimators: int = 80, max_depth: int = 3, learning_rate: float = 0.08):
        self.n_estimators = n_estimators
        self.max_depth = max_depth
        self.learning_rate = learning_rate
        self.device = cuda_device()
        self.trees: list[dict] = []
        self.prior = 0.0
        self.classes_ = np.array([0, 1])

    def fit(self, X, y) -> "CudaGBC":
        x = torch.as_tensor(X, dtype=torch.float32, device=self.device)
        t = torch.as_tensor(y, dtype=torch.float32, device=self.device)
        if x.ndim != 2:
            raise ValueError("X must be 2-D")
        p = float(t.mean().clamp(1e-4, 1 - 1e-4).item())
        self.prior = float(np.log(p / (1.0 - p)))
        f_log = torch.full((x.shape[0],), self.prior, dtype=torch.float32, device=self.device)
        self.trees = []
        for _ in range(self.n_estimators):
            prob = torch.sigmoid(f_log)
            g = prob - t
            h = (prob * (1.0 - prob)).clamp_min(1e-6)
            tree = self._fit_tree(x, g, h)
            self.trees.append(tree)
            f_log = f_log + self.learning_rate * self._eval_tree(tree, x)
        torch.cuda.synchronize()
        return self

    def _fit_tree(self, x: torch.Tensor, g: torch.Tensor, h: torch.Tensor) -> dict:
        n = x.shape[0]
        mask = torch.ones(n, dtype=torch.bool, device=self.device)
        feat, thr, left, right, value, leaf = self._grow(x, g, h, mask, 0)
        return {
            "feat": torch.stack(feat),
            "thr": torch.stack(thr),
            "left": torch.stack(left),
            "right": torch.stack(right),
            "value": torch.stack(value),
            "leaf": torch.stack(leaf),
        }

    def _grow(self, x, g, h, mask, depth) -> tuple[list, list, list, list, list, list]:
        g_sum = (g * mask).sum()
        h_sum = (h * mask).sum().clamp_min(1e-6)
        leaf_val = (-g_sum / h_sum).reshape(())
        n_here = int(mask.sum().item())
        if depth >= self.max_depth or n_here < 4:
            z = torch.tensor(0, device=self.device)
            return (
                [torch.tensor(-1, device=self.device)],
                [torch.tensor(0.0, device=self.device)],
                [z],
                [z],
                [leaf_val],
                [torch.tensor(True, device=self.device)],
            )

        split = self._best_split(x, g, h, mask)
        if split is None:
            z = torch.tensor(0, device=self.device)
            return (
                [torch.tensor(-1, device=self.device)],
                [torch.tensor(0.0, device=self.device)],
                [z],
                [z],
                [leaf_val],
                [torch.tensor(True, device=self.device)],
            )

        f_idx, threshold = split
        go_left = mask & (x[:, f_idx] <= threshold)
        go_right = mask & ~go_left
        if int(go_left.sum().item()) == 0 or int(go_right.sum().item()) == 0:
            z = torch.tensor(0, device=self.device)
            return (
                [torch.tensor(-1, device=self.device)],
                [torch.tensor(0.0, device=self.device)],
                [z],
                [z],
                [leaf_val],
                [torch.tensor(True, device=self.device)],
            )

        lf, lt, ll, lr, lv, lleaf = self._grow(x, g, h, go_left, depth + 1)
        rf, rt, rl, rr, rv, rleaf = self._grow(x, g, h, go_right, depth + 1)
        off_l = 1
        off_r = 1 + len(lf)
        return (
            [torch.tensor(int(f_idx), device=self.device)] + lf + rf,
            [threshold] + lt + rt,
            [torch.tensor(off_l, device=self.device)] + [v + off_l for v in ll] + [v + off_r for v in rl],
            [torch.tensor(off_r, device=self.device)] + [v + off_l for v in lr] + [v + off_r for v in rr],
            [leaf_val] + lv + rv,
            [torch.tensor(False, device=self.device)] + lleaf + rleaf,
        )

    def _best_split(self, x, g, h, mask):
        g_all = (g * mask).sum()
        h_all = (h * mask).sum()
        parent = g_all.square() / h_all.clamp_min(1e-8)
        best_gain = torch.tensor(0.0, device=self.device)
        best_f = -1
        best_thr = torch.tensor(0.0, device=self.device)
        ninf = torch.tensor(float("-inf"), device=self.device)
        for f in range(x.shape[1]):
            xf = x[:, f]
            order = torch.argsort(xf)
            m = mask[order]
            xs = xf[order]
            gs = torch.cumsum(g[order] * m, 0)
            hs = torch.cumsum(h[order] * m, 0)
            g_right = g_all - gs
            h_right = h_all - hs
            valid = m.clone()
            valid[-1] = False
            valid[:-1] = valid[:-1] & (xs[1:] != xs[:-1])
            valid = valid & (hs > 1e-8) & (h_right > 1e-8)
            gain = gs.square() / hs.clamp_min(1e-8) + g_right.square() / h_right.clamp_min(1e-8) - parent
            gain = torch.where(valid, gain, ninf)
            gmax, idx = gain.max(0)
            if gmax > best_gain:
                best_gain = gmax
                best_f = f
                best_thr = xs[idx]
        if best_f < 0:
            return None
        return best_f, best_thr

    def _eval_tree(self, tree: dict, x: torch.Tensor) -> torch.Tensor:
        n = x.shape[0]
        node = torch.zeros(n, dtype=torch.long, device=self.device)
        feat = tree["feat"]
        thr = tree["thr"]
        left = tree["left"]
        right = tree["right"]
        is_leaf = tree["leaf"]
        for _ in range(self.max_depth + 1):
            f = feat[node]
            t = thr[node]
            take = x[torch.arange(n, device=self.device), f.clamp_min(0)]
            nxt = torch.where(take <= t, left[node], right[node])
            node = torch.where(is_leaf[node] | (f < 0), node, nxt)
        return tree["value"][node]

    def predict_proba(self, X):
        x = torch.as_tensor(X, dtype=torch.float32, device=self.device)
        if x.ndim == 1:
            x = x.unsqueeze(0)
        f_log = torch.full((x.shape[0],), self.prior, dtype=torch.float32, device=self.device)
        for tree in self.trees:
            f_log = f_log + self.learning_rate * self._eval_tree(tree, x)
        p1 = torch.sigmoid(f_log)
        p0 = 1.0 - p1
        out = torch.stack([p0, p1], dim=1)
        torch.cuda.synchronize()
        return out.detach().cpu().numpy()

    def save(self, path: Path) -> None:
        payload = {
            "n_estimators": self.n_estimators,
            "max_depth": self.max_depth,
            "learning_rate": self.learning_rate,
            "prior": self.prior,
            "trees": [
                {k: v.detach().cpu() for k, v in tree.items()}
                for tree in self.trees
            ],
        }
        path.parent.mkdir(parents=True, exist_ok=True)
        torch.save(payload, path)

    @classmethod
    def load(cls, path: Path) -> "CudaGBC":
        blob = torch.load(path, map_location="cpu", weights_only=False)
        model = cls(
            n_estimators=blob["n_estimators"],
            max_depth=blob["max_depth"],
            learning_rate=blob["learning_rate"],
        )
        model.prior = float(blob["prior"])
        model.trees = [
            {k: v.to(model.device) for k, v in tree.items()}
            for tree in blob["trees"]
        ]
        return model
