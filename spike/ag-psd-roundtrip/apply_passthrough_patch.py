"""Patch ag-psd 31.0.2 (dist/*.js and dist-es/*.js) so that unknown data is preserved verbatim on round-trip.

1. Additional layer info (per layer and document level) without a handler
   -> raw bytes of the whole block (signature..padding) stored in target._rawUnknownInfo, re-emitted on write.
2. Image resources without a handler (EXIF, IPTC, print settings, ...)
   -> raw block stored in psd.imageResources._rawUnknownResources, re-emitted on write.
Usage: python apply_passthrough_patch.py [node_modules/ag-psd]
"""
import sys, pathlib
pkg = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "node_modules/ag-psd")
roots = [pkg / d for d in ("dist", "dist-es") if (pkg / d).is_dir()]   # dist-es is used by bundlers (Vite)

def patch(fname, old, new, count=1):
    for root in roots:
        p = root / fname; s = p.read_text(encoding="utf-8")
        if new in s: print(f"  already patched: {root.name}/{fname}"); continue
        assert s.count(old) == count, f"{root.name}/{fname}: expected {count} match(es), found {s.count(old)}"
        p.write_text(s.replace(old, new), encoding="utf-8"); print(f"  patched: {root.name}/{fname}")

RAW = "function __rawBytes(reader, start, end) { return new Uint8Array(reader.view.buffer, reader.view.byteOffset + start, end - start).slice(); }\n"

# --- reader: additional layer info -------------------------------------------------
patch("psdReader.js",
"""function readAdditionalLayerInfo(reader, target, psd, imageResources) {
    const sig = realignWithSignature(reader, isValidAdditionalInfoSignature);
    const key = readSignature(reader);""",
RAW + """function readAdditionalLayerInfo(reader, target, psd, imageResources) {
    const sig = realignWithSignature(reader, isValidAdditionalInfoSignature);
    const __start = reader.offset - 4;
    let __unknown = false;
    const key = readSignature(reader);""")
patch("psdReader.js",
"""            reader.logMissingFeatures && reader.log(`Unhandled additional info: ${key}`);
            skipBytes(reader, left());
        }
        if (left()) {
            reader.logMissingFeatures && reader.log(`Unread ${left()} bytes left for additional info: ${key}`);
            skipBytes(reader, left());
        }
    }, false, u64);
}""",
"""            reader.logMissingFeatures && reader.log(`Unhandled additional info: ${key}`);
            skipBytes(reader, left());
            __unknown = true;
        }
        if (left()) {
            reader.logMissingFeatures && reader.log(`Unread ${left()} bytes left for additional info: ${key}`);
            skipBytes(reader, left());
        }
    }, false, u64);
    if (__unknown) {
        // some blocks (e.g. 'CAI ') are padded to 4 bytes while ag-psd only consumes 2-byte padding: keep the zero padding too
        while ((reader.offset - __start) % 4 && reader.offset < reader.view.byteLength && reader.view.getUint8(reader.offset) === 0) reader.offset++;
        (target._rawUnknownInfo || (target._rawUnknownInfo = [])).push({ key, data: __rawBytes(reader, __start, reader.offset) });
    }
}""")

# --- reader: image resources ---------------------------------------------------------
patch("psdReader.js",
"""            realignWithSignature(reader, isValidSignature);
            const id = readUint16(reader);
            readPascalString(reader, 2); // name
            readSection(reader, 2, left => {""",
"""            realignWithSignature(reader, isValidSignature);
            const __resStart = reader.offset - 4;
            let __resUnknown = false;
            const id = readUint16(reader);
            readPascalString(reader, 2); // name
            readSection(reader, 2, left => {""")
patch("psdReader.js",
"""                    // options.logMissingFeatures && console.log(`Unhandled image resource: ${id} (${left()})`);
                    skipBytes(reader, left());
                }
            });""",
"""                    // options.logMissingFeatures && console.log(`Unhandled image resource: ${id} (${left()})`);
                    skipBytes(reader, left());
                    __resUnknown = !handler;
                }
            });
            if (__resUnknown) {
                (imageResources._rawUnknownResources || (imageResources._rawUnknownResources = [])).push({ id, data: __rawBytes(reader, __resStart, reader.offset) });
            }""")

# --- writer: additional layer info ---------------------------------------------------
patch("psdWriter.js",
"""function writeAdditionalLayerInfo(writer, target, psd, options) {
    for (const handler of additionalInfo_1.infoHandlers) {""",
"""function writeAdditionalLayerInfo(writer, target, psd, options) {
    __writeAdditionalLayerInfoKnown(writer, target, psd, options);
    for (const raw of (target._rawUnknownInfo || [])) writeBytes(writer, raw.data);
}
function __writeAdditionalLayerInfoKnown(writer, target, psd, options) {
    for (const handler of additionalInfo_1.infoHandlers) {""")

# --- writer: image resources ---------------------------------------------------------
patch("psdWriter.js",
"""                writeSection(writer, 2, () => handler.write(writer, imageResources, i));
            }
        }
    });""",
"""                writeSection(writer, 2, () => handler.write(writer, imageResources, i));
            }
        }
        for (const raw of (imageResources._rawUnknownResources || [])) writeBytes(writer, raw.data);
    });""")
print("done")
