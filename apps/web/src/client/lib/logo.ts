/** The server's limit (LOGO_MAX_BYTES): pictures are shrunk well below it first. */
const MAX_BYTES = 100_000;
/** The longest side kept: well over the kiosk's size, for sharp screens. */
const SIDES = [256, 192, 128] as const;
/** Pictures larger than this aren't even opened. */
const MAX_FILE = 20_000_000;

export interface ShrunkLogo {
  /** The picture as base64, for the upload. */
  base64: string;
  /** For showing it before it's saved. */
  dataUrl: string;
  /** True when see-through parts had to become white (a JPEG). */
  flattened: boolean;
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
 * can show) to a small WebP, PNG or JPEG. Drawing it onto a canvas also means
 * only plain pixels are uploaded: nothing else in the original file comes along.
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
    const vector = file.type === "image/svg+xml";
    // An SVG may have no size of its own; it's square until it says otherwise.
    const width = img.naturalWidth || 1;
    const height = img.naturalHeight || 1;
    const canvas = document.createElement("canvas");

    const draw = (side: number, background?: string) => {
      // Drawings (SVG) are drawn at full size, however small they say they are;
      // photos are only ever made smaller.
      const scale = vector
        ? side / Math.max(width, height)
        : Math.min(1, side / Math.max(width, height));
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const g = canvas.getContext("2d");
      if (!g) throw new LogoError("This browser can't prepare pictures. Try another browser.");
      if (background) {
        g.fillStyle = background;
        g.fillRect(0, 0, canvas.width, canvas.height);
      }
      try {
        g.drawImage(img, 0, 0, canvas.width, canvas.height);
      } catch {
        throw new LogoError("That picture couldn't be opened. Try a PNG or JPEG.");
      }
    };

    // Keep see-through parts if it fits: WebP is smallest; Safari can only make PNG.
    for (const side of SIDES) {
      draw(side);
      let blob = await toBlob(canvas, "image/webp", 0.9);
      if (blob?.type !== "image/webp") blob = await toBlob(canvas, "image/png");
      if (blob && blob.size <= MAX_BYTES) {
        const dataUrl = await readDataUrl(blob);
        return { base64: dataUrl.slice(dataUrl.indexOf(",") + 1), dataUrl, flattened: false };
      }
    }
    // A busy photo: JPEG, on white since it can't be see-through.
    draw(SIDES[0], "#ffffff");
    const blob = await toBlob(canvas, "image/jpeg", 0.85);
    if (!blob || blob.size > MAX_BYTES) {
      throw new LogoError("That picture is too detailed to use. Try a simpler one.");
    }
    const dataUrl = await readDataUrl(blob);
    return { base64: dataUrl.slice(dataUrl.indexOf(",") + 1), dataUrl, flattened: true };
  } finally {
    URL.revokeObjectURL(url);
  }
}
