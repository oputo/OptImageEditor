"""PSD feature usage scanner (psd-tools 1.23).

Usage: python psd_scan.py <psd file or folder> [...]
Requires: pip install psd-tools
"""
import sys, json, collections
from pathlib import Path
from psd_tools import PSDImage
from psd_tools.constants import Tag

def scan(path):
    psd = PSDImage.open(path)
    info = {
        "file": Path(path).name,
        "size": f"{psd.width}x{psd.height}",
        "mode": str(psd.color_mode).split(".")[-1],
        "depth": psd.depth,
        "channels": psd.channels,
        "has_composite": psd.has_preview(),
        "icc": bool(psd.image_resources.get_data(1039)) if psd.image_resources else False,
        "xmp": bool(psd.image_resources.get_data(1060)) if psd.image_resources else False,  # PS-saved files normally have XMP
    }
    c = collections.Counter()
    layers = []
    def walk(group, depth=0):
        for l in group:
            k = l.kind
            c[f"kind:{k}"] += 1
            bm = str(l.blend_mode).split(".")[-1]
            if bm not in ("NORMAL", "PASS_THROUGH"):
                c[f"blend:{bm}"] += 1
            if l.opacity < 255: c["opacity<100%"] += 1
            try:
                fill = l.tagged_blocks.get_data(Tag.BLEND_FILL_OPACITY) if l.tagged_blocks else None
                if fill is not None and fill < 255: c["fill<100%"] += 1
            except Exception: pass
            if not l.visible: c["hidden"] += 1
            if l.clipping: c["clipping"] += 1
            if l.has_mask(): c["layer_mask"] += 1
            if l.has_vector_mask(): c["vector_mask"] += 1
            if l.has_effects():
                for e in l.effects:
                    c[f"effect:{type(e).__name__}"] += 1
            if k == "smartobject":
                so = l.smart_object
                c[f"smartobj:{so.kind}"] += 1
                try:
                    if l.tagged_blocks.get_data(Tag.SMART_FILTER) or l.tagged_blocks.get_data(Tag.FILTER_EFFECTS1):
                        c["smart_filter"] += 1
                except Exception: pass
            if k == "adjustment" or k == "fill":
                c[f"{k}:{type(l).__name__}"] += 1
            layers.append(("  " * depth) + f"[{k}] {l.name} | {bm} | op={round(l.opacity/2.55)}%"
                          + (" | clip" if l.clipping else "")
                          + (" | mask" if l.has_mask() else "")
                          + (" | fx" if l.has_effects() else "")
                          + ("" if l.visible else " | hidden"))
            if l.is_group():
                walk(l, depth + 1)
    walk(psd)
    info["layer_total"] = sum(v for k, v in c.items() if k.startswith("kind:"))
    return info, c, layers

if __name__ == "__main__":
    files = []
    for a in sys.argv[1:]:
        p = Path(a)
        files += sorted(p.rglob("*.psd")) + sorted(p.rglob("*.psb")) if p.is_dir() else [p]
    total = collections.Counter()
    for f in files:
        try:
            info, c, layers = scan(f)
        except Exception as e:
            print(f"!! {f.name}: {e}"); continue
        total.update(c)
        print("=" * 70); print(json.dumps(info, ensure_ascii=False))
        print("\n".join(layers))
    print("=" * 70); print(f"TOTAL ({len(files)} files)")
    for k, v in sorted(total.items()):
        print(f"  {k}: {v}")
