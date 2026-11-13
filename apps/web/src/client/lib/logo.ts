/** The server's limit (LOGO_MAX_BYTES): pictures are shrunk well below it first. */
const MAX_BYTES = 100_000;
/** The longest side kept: twice the header's size, for sharp screens. */
const MAX_SIDE = 256;
/** Pictures larger than this aren't even opened. */
const MAX_FILE = 20_000_000;

export interface ShrunkLogo {
  /** The picture as base64, for the upload. */
  base64: string;
  /** For showing it before it's saved. */
  dataUrl: string;
  bytes: number;
}

export class LogoError extends Error {}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

function readDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/**
 * Shrinks a chosen picture (PNG, JPEG, WebP, SVG or anything else the browser
 * can show) to a small PNG, WebP or JPEG. Drawing it onto a canvas also means
 * only plain pixels are uploaded: nothing in the original file comes along.
 */
export async function shrinkLogo(file: File): Promise<ShrunkLogo> {
  if (!file.type.startsWith("image/")) throw new LogoError("Choose a picture file.");
  if (file.size > MAX_FILE) throw new LogoError("That picture is too big. Try a smaller one.");
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    try {
      await img.decode();
    } catch {
      throw new LogoError("That picture couldn't be opened. Try a PNG or JPEG.");
    }
    // An SVG may have no size of its own.
    const width = img.naturalWidth || MAX_SIDE;
    const height = img.naturalHeight || MAX_SIDE;
    const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const draw = (background?: string) => {
      const g = canvas.getContext("2d");
      if (!g) throw new LogoError("This browser can't prepare pictures. Try another browser.");
      g.clearRect(0, 0, canvas.width, canvas.height);
      if (background) {
        g.fillStyle = background;
        g.fillRect(0, 0, canvas.width, canvas.height);
      }
      g.drawImage(img, 0, 0, canvas.width, canvas.height);
    };

    draw();
    // WebP is smallest and keeps transparency; Safari can't make it, so PNG.
    let blob = await toBlob(canvas, "image/webp", 0.9);
    if (blob?.type !== "image/webp") blob = await toBlob(canvas, "image/png");
    if (!blob || blob.size > MAX_BYTES) {
      // A busy photo: JPEG, on white since it can't be see-through.
      draw("#ffffff");
      blob = await toBlob(canvas, "image/jpeg", 0.85);
    }
    if (!blob || blob.size > MAX_BYTES) {
      throw new LogoError("That picture is too detailed to use. Try a simpler one.");
    }
    const dataUrl = await readDataUrl(blob);
    return { base64: dataUrl.slice(dataUrl.indexOf(",") + 1), dataUrl, bytes: blob.size };
  } finally {
    URL.revokeObjectURL(url);
  }
}
