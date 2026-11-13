export const MAX_BANNER_INPUT_BYTES = 5 * 1024 * 1024;
export const MAX_STORED_BANNER_BYTES = 600 * 1024;
export const MAX_BANNER_EDGE = 1600;
export function bannerReference(path: string): { uid: string; id: string } | null {
  const match = /^account-banners\/([A-Za-z0-9_-]{1,128})\/([a-f0-9]{32})$/.exec(path);
  return match ? { uid: match[1], id: match[2] } : null;
}
export function imageDetails(
  bytes: Uint8Array,
): { type: string; width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0,
    height = 0,
    type = '';
  if (
    bytes.length >= 33 &&
    [137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b) &&
    bytes[12] === 73 &&
    bytes[13] === 72 &&
    bytes[14] === 68 &&
    bytes[15] === 82
  ) {
    width = view.getUint32(16);
    height = view.getUint32(20);
    type = 'image/png';
  } else if (
    bytes.length >= 4 &&
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes[2] === 255 &&
    bytes.at(-2) === 255 &&
    bytes.at(-1) === 217
  ) {
    for (let offset = 2; offset + 3 < bytes.length;) {
      if (bytes[offset++] !== 255) return null;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (offset + 2 > bytes.length) return null;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) return null;
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
        if (length < 8) return null;
        height = view.getUint16(offset + 3);
        width = view.getUint16(offset + 5);
        type = 'image/jpeg';
        break;
      }
      offset += length;
    }
  }
  return type && width > 0 && height > 0 && width <= MAX_BANNER_EDGE && height <= MAX_BANNER_EDGE
    ? { type, width, height }
    : null;
}
