"""Writes reference RGBA dumps (<name>.rgba) of PSD composites with psd-tools, for the Rust decoder test.

Usage:
    pip install psd-tools numpy
    python tools/composite_ref.py <dir with .psd files>
    # then (in app/src-tauri):  OIE_SAMPLES=<dir> cargo test --release -- --nocapture samples
"""
import glob, os, sys, warnings, logging
import numpy as np
from psd_tools import PSDImage

warnings.filterwarnings("ignore"); logging.disable(logging.WARNING)
d = sys.argv[1] if len(sys.argv) > 1 else "."
for f in sorted(glob.glob(os.path.join(d, "*.ps[db]"))):
    im = PSDImage.open(f).topil()
    out = os.path.splitext(f)[0] + ".rgba"
    open(out, "wb").write(np.asarray(im.convert("RGBA")).tobytes())
    print(f"{os.path.basename(f)}: {im.mode} {im.size} -> {os.path.basename(out)}")
