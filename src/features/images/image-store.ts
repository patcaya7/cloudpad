// Local store for images pasted into notes. The note text only carries a small
// token like [ภาพ:<id>]; the actual bitmap lives here, keyed by that id, so note
// content/HTML stay plain text and every existing pipeline (undo, search, sync,
// formatting round-trip) keeps working untouched.
//
// Storage is per-device localStorage: images do NOT sync to the cloud — on another
// device the token renders as a "missing image" placeholder.

const IMAGE_KEY_PREFIX = 'cloudpad.image.';

// Above this size the bitmap is downscaled/re-encoded before storing, so a couple
// of large screenshots can't exhaust the localStorage quota.
const DOWNSCALE_THRESHOLD_BYTES = 1_500_000;
const DOWNSCALE_MAX_DIMENSION = 1600;

export const IMAGE_TOKEN_PATTERN = /\[ภาพ:([0-9a-fA-F][0-9a-fA-F-]{7,})\]/g;

export function imageTokenFor(id: string): string {
  return `[ภาพ:${id}]`;
}

export function getStoredImage(id: string): string | null {
  try {
    return localStorage.getItem(`${IMAGE_KEY_PREFIX}${id}`);
  } catch {
    return null;
  }
}

function newImageId(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

function readFileAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('อ่านไฟล์รูปไม่สำเร็จ'));
    reader.readAsDataURL(file);
  });
}

async function downscaleDataUrl(dataUrl: string): Promise<string> {
  const image = new Image();
  image.src = dataUrl;
  await image.decode();

  const scale = Math.min(1, DOWNSCALE_MAX_DIMENSION / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext('2d');
  if (!context) return dataUrl;
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.85);
}

// Persist the image and return the id to embed as a token, or null when storage
// is full (the caller should tell the user instead of silently dropping the paste).
export async function storeImageFromBlob(file: Blob): Promise<string | null> {
  let dataUrl = await readFileAsDataUrl(file);
  if (dataUrl.length > DOWNSCALE_THRESHOLD_BYTES) {
    try {
      dataUrl = await downscaleDataUrl(dataUrl);
    } catch {
      // keep the original if decoding fails; storage may still fit
    }
  }

  const id = newImageId();
  try {
    localStorage.setItem(`${IMAGE_KEY_PREFIX}${id}`, dataUrl);
    return id;
  } catch {
    return null;
  }
}

// ---- Cloud sync ------------------------------------------------------------
// Image bitmaps ride along inside content_html as HTML comments, so they sync
// through the existing notes table with zero schema/bucket changes. Comments are
// invisible to the editor's HTML parser (not text nodes, not elements), so the
// text-match safety check and all formatting round-trips are unaffected.

const IMAGE_COMMENT_PATTERN =
  /<!--cloudpad-image:([0-9a-fA-F][0-9a-fA-F-]{7,}):(data:image\/[a-zA-Z+.-]+;base64,[A-Za-z0-9+/=]+)-->/g;

function stripImageComments(contentHtml: string): string {
  IMAGE_COMMENT_PATTERN.lastIndex = 0;
  return contentHtml.replace(IMAGE_COMMENT_PATTERN, '');
}

// Called on every save: re-derive the embedded set from the tokens actually
// present, so deleted images drop out of the synced payload automatically.
export function embedImagesInContentHtml(contentHtml: string): string {
  const base = stripImageComments(contentHtml);
  if (!base.includes('[ภาพ:')) return base;

  const ids = new Set<string>();
  IMAGE_TOKEN_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = IMAGE_TOKEN_PATTERN.exec(base)) !== null) ids.add(match[1]);

  let comments = '';
  for (const id of ids) {
    const dataUrl = getStoredImage(id);
    if (dataUrl) comments += `<!--cloudpad-image:${id}:${dataUrl}-->`;
  }
  return base + comments;
}

// Called when notes are loaded (boot / after cloud sync): unpack any embedded
// bitmaps this device doesn't have yet into the local store.
export function hydrateImagesFromContentHtml(contentHtml: string | undefined): void {
  if (!contentHtml || !contentHtml.includes('<!--cloudpad-image:')) return;
  IMAGE_COMMENT_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = IMAGE_COMMENT_PATTERN.exec(contentHtml)) !== null) {
    const [, id, dataUrl] = match;
    if (!getStoredImage(id)) {
      try {
        localStorage.setItem(`${IMAGE_KEY_PREFIX}${id}`, dataUrl);
      } catch {
        // quota full: the token will render as a missing-image placeholder
      }
    }
  }
}

export async function copyStoredImageToClipboard(id: string): Promise<boolean> {
  const dataUrl = getStoredImage(id);
  if (!dataUrl) return false;
  try {
    const blob = await (await fetch(dataUrl)).blob();
    // Chromium's async clipboard accepts png reliably; convert other encodings.
    const pngBlob = blob.type === 'image/png' ? blob : await reencodeAsPng(dataUrl);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
    return true;
  } catch {
    return false;
  }
}

async function reencodeAsPng(dataUrl: string): Promise<Blob> {
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  canvas.getContext('2d')?.drawImage(image, 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('แปลงรูปไม่สำเร็จ'))), 'image/png');
  });
}
