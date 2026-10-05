"""Extra checks: global tagged blocks, linked (smart object) files, smart object/adjustment layer data.
Usage: python compare_extra.py <orig.psd> <roundtrip.psd>"""
import sys, warnings, logging, hashlib
import numpy as np
from psd_tools import PSDImage
from psd_tools.constants import Tag
warnings.filterwarnings("ignore"); logging.disable(logging.WARNING)
o, r = PSDImage.open(sys.argv[1]), PSDImage.open(sys.argv[2])
gt = lambda p: p._record.layer_and_mask_information.tagged_blocks
gk = lambda p: {str(getattr(k, "value", k)) for k in gt(p).keys()}
print("global tags lost:", sorted(gk(o) - gk(r)) or "none", "| added:", sorted(gk(r) - gk(o)) or "none")
def linked(p):
    out = {}
    for tag in (Tag.LINKED_LAYER1, Tag.LINKED_LAYER2, Tag.LINKED_LAYER3, Tag.LINKED_LAYER_EXTERNAL):
        d = gt(p).get_data(tag)
        if d:
            for item in d:
                out[str(item.uuid)] = (str(item.filename).strip("\x00"), hashlib.md5(item.data or b"").hexdigest(), len(item.data or b""))
    return out
lo, lr = linked(o), linked(r)
print(f"embedded smart-object files: {len(lo)} -> {len(lr)}")
for u, v in lo.items():
    w = lr.get(u)
    print(f"  {v[0]} ({v[2]/2**20:.1f}MB): " + ("identical" if w and w[1] == v[1] else ("MISSING" if not w else "DIFF")))
for a, b in zip(o.descendants(), r.descendants()):
    notes = []
    if a.kind == "smartobject":
        sa, sb = a.smart_object, b.smart_object
        if sa.unique_id != sb.unique_id: notes.append("uuid changed")
        if sa.transform_box != sb.transform_box: notes.append("transform changed")
        A = np.asarray(a.topil().convert("RGBA")).astype(int); B = np.asarray(b.topil().convert("RGBA")).astype(int)
        if A.shape != B.shape or np.abs(A - B).max() > 0: notes.append("rendered pixels differ")
    if a.kind in ("huesaturation", "solidcolorfill", "levels", "curves", "brightnesscontrast", "colorbalance", "exposure"):
        if repr(a.data if hasattr(a, "data") else None) != repr(b.data if hasattr(b, "data") else None): notes.append("adjustment data differs")
    if a.kind == "solidcolorfill" and repr(a.data) != repr(b.data): notes.append("fill data differs")
    if a.kind in ("smartobject", "huesaturation", "solidcolorfill"):
        print(f"  [{a.kind}] {a.name}: " + ("OK" if not notes else " | ".join(notes)))
