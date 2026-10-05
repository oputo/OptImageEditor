// Reads only the parts of a PSD/PSB needed to show the stored composite image.
//
// PSD layout: header(26) | color mode data | image resources | layer & mask info | image data (composite)
// The layer & mask section usually makes up most of the file (hundreds of MB), but the composite
// sits after it. With random access we read the small sections, skip the layer section entirely,
// and rebuild a minimal PSD whose layer section is empty. ag-psd then only decodes the composite.
import type { FileSource } from "./source";

export type PsdSliceResult = {
  buffer: ArrayBuffer; // minimal PSD: header + color mode + resources + empty layer section + image data
  layerRecords: number | null; // number of layer records (includes group end markers); null if unknown
  bytesRead: number;
};

const readU32 = (v: DataView, o: number) => v.getUint32(o);
const readU64 = (v: DataView, o: number) => Number(v.getBigUint64(o));

export async function readPsdCompositeOnly(file: FileSource): Promise<PsdSliceResult> {
  // 1) header + color mode + image resources (+ layer section length) — small, read up front
  const headLen = Math.min(file.size, 1 << 20);
  let head = new DataView(await file.read(0, headLen));
  if (head.getUint32(0) !== 0x38425053) throw new Error("PSD ではありません（シグネチャ不一致）"); // '8BPS'
  const version = head.getUint16(4);
  const isPsb = version === 2;

  let pos = 26;
  const colorModeLen = readU32(head, pos);
  const resourcesLenPos = pos + 4 + colorModeLen;
  const ensure = async (need: number) => {
    if (need <= head.byteLength) return;
    head = new DataView(await file.read(0, Math.min(file.size, need + (1 << 20))));
  };
  await ensure(resourcesLenPos + 4);
  const resourcesLen = readU32(head, resourcesLenPos);
  const layerLenPos = resourcesLenPos + 4 + resourcesLen;
  const lenSize = isPsb ? 8 : 4;
  // also peek the first bytes of the layer section to get the layer record count
  await ensure(layerLenPos + lenSize * 2 + 2);
  const layerSectionLen = isPsb ? readU64(head, layerLenPos) : readU32(head, layerLenPos);
  let layerRecords: number | null = null;
  if (layerSectionLen >= lenSize + 2) {
    const layerInfoLen = isPsb ? readU64(head, layerLenPos + lenSize) : readU32(head, layerLenPos + lenSize);
    if (layerInfoLen > 0) layerRecords = Math.abs(head.getInt16(layerLenPos + lenSize * 2));
  }
  const imageDataPos = layerLenPos + lenSize + layerSectionLen;
  if (imageDataPos > file.size) throw new Error("PSD のセクション長が不正です");

  // 2) composite image data: from imageDataPos to end of file
  const imageData = await file.read(imageDataPos, file.size - imageDataPos);

  // 3) rebuild: [0, layerLenPos) + zero-length layer section + image data
  const prefix = new Uint8Array(head.buffer, 0, layerLenPos);
  const out = new Uint8Array(layerLenPos + lenSize + imageData.byteLength);
  out.set(prefix, 0);
  // layer section length = 0 (bytes already zero)
  out.set(new Uint8Array(imageData), layerLenPos + lenSize);

  return { buffer: out.buffer, layerRecords, bytesRead: layerLenPos + lenSize * 2 + 2 + imageData.byteLength };
}
