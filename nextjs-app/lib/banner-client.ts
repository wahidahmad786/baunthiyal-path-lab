import { MAX_BANNER_INPUT_BYTES, MAX_BANNER_EDGE, MAX_STORED_BANNER_BYTES } from './banner';

/** Re-encode on the device to bound database size and remove original file metadata. */
export async function prepareBanner(file: File): Promise<Blob> {
  if (
    !['image/png', 'image/jpeg'].includes(file.type) ||
    !file.size ||
    file.size > MAX_BANNER_INPUT_BYTES
  )
    throw new Error('Choose a PNG or JPEG image up to 5 MB.');
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = objectUrl;
    try {
      await image.decode();
    } catch {
      throw new Error('This image could not be opened. Choose another PNG or JPEG.');
    }
    if (
      !image.naturalWidth ||
      !image.naturalHeight ||
      image.naturalWidth * image.naturalHeight > 40000000
    )
      throw new Error('Choose an image smaller than 40 megapixels.');
    for (const edge of [MAX_BANNER_EDGE, 1200, 800]) {
      const scale = Math.min(1, edge / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Image processing is unavailable in this browser.');
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.88, 0.72, 0.55]) {
        const blob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, 'image/jpeg', quality),
        );
        if (blob && blob.size <= MAX_STORED_BANNER_BYTES) return blob;
      }
    }
    throw new Error('This image is too detailed to save. Choose a smaller banner.');
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
