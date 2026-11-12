// =========================================================================
// INGESTION ENGINE: MULTI-FILE, FOLDER & OFFLINE ZIP PARSER
// =========================================================================
export function getMimeType(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  const types = {
    'html': 'text/html',
    'htm': 'text/html',
    'css': 'text/css',
    'js': 'application/javascript',
    'mjs': 'application/javascript',
    'json': 'application/json',
    'svg': 'image/svg+xml',
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'gif': 'image/gif',
    'webp': 'image/webp',
    'wav': 'audio/wav',
    'mp3': 'audio/mpeg',
    'ogg': 'audio/ogg',
    'txt': 'text/plain'
  };
  return types[ext] || 'application/octet-stream';
}

export function isTextFile(mime) {
  return mime.startsWith('text/') || mime === 'application/javascript' || mime === 'application/json' || mime === 'image/svg+xml';
}

export function normalizeFileTree(files) {
  const keys = Object.keys(files);
  if (keys.length === 0) return files;
  const parts = keys.map(k => k.split('/'));
  if (parts.every(p => p.length > 1 && p[0] === parts[0][0])) {
    const rootDir = parts[0][0] + '/';
    const normalized = {};
    for (const k of keys) {
      normalized[k.slice(rootDir.length)] = files[k];
    }
    return normalized;
  }
  return files;
}

export async function readFileContent(file) {
  return new Promise((resolve) => {
    const mime = getMimeType(file.name);
    const reader = new FileReader();

    if (isTextFile(mime)) {
      reader.onload = (e) => resolve({ content: e.target.result, isBinary: false, type: mime });
      reader.readAsText(file);
    } else {
      reader.onload = (e) => {
        const bytes = new Uint8Array(e.target.result);
        let binaryStr = '';
        for (let i = 0; i < bytes.byteLength; i++) {
          binaryStr += String.fromCharCode(bytes[i]);
        }
        resolve({ content: btoa(binaryStr), isBinary: true, type: mime });
      };
      reader.readAsArrayBuffer(file);
    }
  });
}

// Pure Offline ZIP Parser using browser native DecompressionStream('deflate-raw')
export async function parseZipBuffer(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  const files = {};

  let eocdOffset = -1;
  for (let i = arrayBuffer.byteLength - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }

  if (eocdOffset === -1) {
    throw new Error("End of Central Directory not found in ZIP.");
  }

  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);

  let cur = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (view.getUint32(cur, true) !== 0x02014b50) break;

    const method = view.getUint16(cur + 10, true);
    const compressedSize = view.getUint32(cur + 20, true);
    const uncompressedSize = view.getUint32(cur + 24, true);
    const fnLen = view.getUint16(cur + 28, true);
    const extraLen = view.getUint16(cur + 30, true);
    const commentLen = view.getUint16(cur + 32, true);
    const localOffset = view.getUint32(cur + 42, true);

    const filenameBytes = new Uint8Array(arrayBuffer, cur + 46, fnLen);
    const filename = new TextDecoder().decode(filenameBytes);

    cur += 46 + fnLen + extraLen + commentLen;

    if (filename.endsWith('/') || filename.includes('__MACOSX/') || filename.endsWith('.DS_Store')) {
      continue;
    }

    if (view.getUint32(localOffset, true) !== 0x04034b50) continue;
    const localFnLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const dataOffset = localOffset + 30 + localFnLen + localExtraLen;

    let decompressedBytes = null;
    if (method === 0) {
      decompressedBytes = new Uint8Array(arrayBuffer, dataOffset, uncompressedSize);
    } else if (method === 8) {
      const compressed = new Uint8Array(arrayBuffer, dataOffset, compressedSize);
      if (typeof DecompressionStream !== 'undefined') {
        const ds = new DecompressionStream('deflate-raw');
        const writer = ds.writable.getWriter();
        writer.write(compressed);
        writer.close();
        const resp = new Response(ds.readable);
        const buf = await resp.arrayBuffer();
        decompressedBytes = new Uint8Array(buf);
      } else {
        throw new Error("DecompressionStream is unsupported on this device.");
      }
    } else {
      continue;
    }

    const mime = getMimeType(filename);
    const isText = isTextFile(mime);

    if (isText) {
      files[filename] = {
        content: new TextDecoder().decode(decompressedBytes),
        type: mime,
        isBinary: false
      };
    } else {
      let binaryStr = '';
      for (let b = 0; b < decompressedBytes.byteLength; b++) {
        binaryStr += String.fromCharCode(decompressedBytes[b]);
      }
      files[filename] = {
        content: btoa(binaryStr),
        type: mime,
        isBinary: true
      };
    }
  }

  return files;
}