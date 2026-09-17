// 사진 압축: 긴 변을 줄이고 JPEG 품질을 낮춰 목표 용량 이하로 만든다.
export async function compressImage(file, opts = {}) {
  const maxSide = opts.maxSide || 1280;
  let quality = opts.quality || 0.8;
  const maxBytes = opts.maxBytes || 250 * 1024;

  const bitmap = await loadBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, w, h);
  if (bitmap.close) bitmap.close();

  let blob = await toBlob(canvas, quality);
  // 목표 용량을 넘으면 품질을 단계적으로 낮춘다 (최소 0.45)
  while (blob.size > maxBytes && quality > 0.45) {
    quality -= 0.1;
    blob = await toBlob(canvas, quality);
  }
  return blob;
}

async function loadBitmap(file) {
  if ("createImageBitmap" in window) {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch (e) {
      // 일부 브라우저는 옵션을 지원하지 않음 → 아래 fallback
    }
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("이미지를 읽을 수 없어요")); };
    img.src = url;
  });
}

function toBlob(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("이미지 변환 실패"))), "image/jpeg", quality);
  });
}
