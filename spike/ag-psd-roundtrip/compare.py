"""Compare original PSD vs ag-psd round-trip output using psd-tools (oracle).
Usage: python compare.py <orig.psd> <roundtrip.psd>"""
import sys, warnings, logging
import numpy as np
from psd_tools import PSDImage
warnings.filterwarnings("ignore"); logging.disable(logging.WARNING)

def rkeys(p): return {int(k) for k in p.image_resources.keys()}
def tkeys(l): return {getattr(k, "value", k) for k in l.tagged_blocks.keys()} if l.tagged_blocks else set()
def tostr(k): return k.decode("latin1") if isinstance(k, bytes) else str(k)
def arr(im): return np.asarray(im.convert("RGBA")).astype(int) if im is not None else None

def diff(a, b):
    if a is None or b is None: return "n/a" if a is None and b is None else "MISSING"
    if a.shape != b.shape: return f"shape {a.shape} vs {b.shape}"
    d = np.abs(a - b); return "identical" if d.max() == 0 else f"max={d.max()} mean={d.mean():.4f}"

o, r = PSDImage.open(sys.argv[1]), PSDImage.open(sys.argv[2])
print(f"# {sys.argv[1].split('/')[-1]}")
print("header:", "same" if (o.size, o.depth, o.channels, o.color_mode) == (r.size, r.depth, r.channels, r.color_mode)
      else f"{(o.size, o.depth, o.channels, o.color_mode)} -> {(r.size, r.depth, r.channels, r.color_mode)}")
lost_r, added_r = rkeys(o) - rkeys(r), rkeys(r) - rkeys(o)
print("image resources lost:", sorted(lost_r) or "none", "| added:", sorted(added_r) or "none")
print("composite:", diff(arr(o.topil()), arr(r.topil())))
lo, lr = list(o.descendants()), list(r.descendants())
print("layer count:", len(lo), "->", len(lr))
for a, b in zip(lo, lr):
    attrs = lambda l: (l.name, l.kind, str(l.blend_mode), l.opacity, l.visible, l.clipping, l.bbox, l.has_mask())
    ch = [] if attrs(a) == attrs(b) else [f"attrs {attrs(a)} -> {attrs(b)}"]
    lt, at = tkeys(a) - tkeys(b), tkeys(b) - tkeys(a)
    if lt: ch.append("tags lost: " + ",".join(sorted(map(tostr, lt))))
    if at: ch.append("tags added: " + ",".join(sorted(map(tostr, at))))
    if a.kind == "pixel" or a.kind == "type":
        px = diff(arr(a.topil()), arr(b.topil()))
        if px != "identical": ch.append("pixels " + px)
        if a.has_mask():
            md = diff(arr(a.mask.topil()), arr(b.mask.topil()))
            if md != "identical": ch.append("mask " + md)
    if a.kind == "type":
        if a.text != b.text: ch.append(f"text {a.text!r} -> {b.text!r}")
        try:
            fa = [f["Name"] for f in a.resource_dict["FontSet"]]; fb = [f["Name"] for f in b.resource_dict["FontSet"]]
            if fa != fb: ch.append(f"fonts {fa} -> {fb}")
            sa = a.engine_dict["StyleRun"]["RunArray"][0]["StyleSheet"]["StyleSheetData"]
            sb = b.engine_dict["StyleRun"]["RunArray"][0]["StyleSheet"]["StyleSheetData"]
            dk = [k for k in set(sa) | set(sb) if sa.get(k) != sb.get(k)]
            if dk: ch.append(f"style diff keys {sorted(map(str, dk))[:8]}")
            if a.transform != b.transform: ch.append("transform changed")
        except Exception as e: ch.append(f"text-compare-error {e}")
    print(f"  [{a.kind}] {a.name}: " + ("OK" if not ch else " | ".join(ch)))
