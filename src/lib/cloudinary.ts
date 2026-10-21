/**
 * Cloudinary Storage Integration
 * Permite subir fotos y videos directamente a Cloudinary mediante Unsigned Upload Presets
 * sin exponer API Keys secretas en el cliente.
 */

export interface CloudinaryConfig {
  cloudName: string;
  uploadPreset: string;
  folder: string;
  isConfigured: boolean;
}

// Configuración por defecto o variables de entorno
const DEFAULT_CLOUD_NAME = import.meta.env.PUBLIC_CLOUDINARY_CLOUD_NAME || '';
const DEFAULT_UPLOAD_PRESET = import.meta.env.PUBLIC_CLOUDINARY_UPLOAD_PRESET || '';
const DEFAULT_FOLDER = import.meta.env.PUBLIC_CLOUDINARY_FOLDER || 'senati_galeria';

export function getCloudinaryConfig(): CloudinaryConfig {
  let cloudName = DEFAULT_CLOUD_NAME;
  let uploadPreset = DEFAULT_UPLOAD_PRESET;
  let folder = DEFAULT_FOLDER;

  if (typeof window !== 'undefined') {
    const savedCloudName = localStorage.getItem('senati_cloudinary_cloud_name');
    const savedPreset = localStorage.getItem('senati_cloudinary_upload_preset');
    const savedFolder = localStorage.getItem('senati_cloudinary_folder');

    if (savedCloudName) cloudName = savedCloudName;
    if (savedPreset) uploadPreset = savedPreset;
    if (savedFolder) folder = savedFolder;
  }

  const isConfigured = Boolean(cloudName && uploadPreset);

  return { cloudName, uploadPreset, folder, isConfigured };
}

export function isCloudinaryConfigured(): boolean {
  return getCloudinaryConfig().isConfigured;
}

export function saveCloudinaryConfig(cloudName: string, uploadPreset: string, folder: string = 'senati_galeria') {
  if (typeof window !== 'undefined') {
    localStorage.setItem('senati_cloudinary_cloud_name', cloudName.trim());
    localStorage.setItem('senati_cloudinary_upload_preset', uploadPreset.trim());
    localStorage.setItem('senati_cloudinary_folder', folder.trim());
  }
}

export interface CloudinaryUploadResult {
  publicUrl: string;
  publicId: string;
  format?: string;
  bytes?: number;
  duration?: number;
  resourceType: 'image' | 'video';
}

/**
 * Sube una imagen o video directamente a Cloudinary vía REST API
 */
export async function uploadMediaToCloudinary(
  file: File | Blob,
  mediaType: 'image' | 'video' = 'image'
): Promise<CloudinaryUploadResult> {
  const config = getCloudinaryConfig();

  if (!config.isConfigured) {
    throw new Error('Cloudinary no está configurado. Por favor define PUBLIC_CLOUDINARY_CLOUD_NAME y PUBLIC_CLOUDINARY_UPLOAD_PRESET en tu archivo .env');
  }

  const resourceType = mediaType === 'video' ? 'video' : 'image';
  const url = `https://api.cloudinary.com/v1_1/${config.cloudName}/${resourceType}/upload`;

  const formData = new FormData();
  formData.append('file', file);
  formData.append('upload_preset', config.uploadPreset);
  if (config.folder) {
    formData.append('folder', config.folder);
  }

  const response = await fetch(url, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    let errorDetail = `Error HTTP ${response.status}`;
    try {
      const errJson = await response.json();
      if (errJson?.error?.message) {
        errorDetail = errJson.error.message;
      }
    } catch {}
    throw new Error(`Cloudinary Error: ${errorDetail}`);
  }

  const data = await response.json();

  if (!data.secure_url) {
    throw new Error('Cloudinary no devolvió una secure_url válida.');
  }

  return {
    publicUrl: data.secure_url,
    publicId: data.public_id,
    format: data.format,
    bytes: data.bytes,
    duration: data.duration,
    resourceType: mediaType
  };
}

/**
 * Extrae el public_id de una URL de Cloudinary
 * Ejemplo: https://res.cloudinary.com/demo/image/upload/v1234/senati_galeria/foto.webp -> senati_galeria/foto
 */
export function extractCloudinaryPublicId(url: string): string | null {
  if (!url || !url.includes('cloudinary.com')) return null;
  const match = url.match(/\/upload\/(?:[a-zA-Z0-9_,]+\/)?(?:v\d+\/)?(.+?)(?:\.[a-zA-Z0-9]+)?$/);
  if (!match) return null;
  return decodeURIComponent(match[1]);
}

async function sha1Hex(str: string): Promise<string> {
  const enc = new TextEncoder();
  const buffer = await crypto.subtle.digest('SHA-1', enc.encode(str));
  return Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Elimina un recurso (foto o video) directamente de Cloudinary
 */
export async function deleteMediaFromCloudinary(
  urlOrPublicId: string,
  mediaType: 'image' | 'video' = 'image'
): Promise<boolean> {
  const config = getCloudinaryConfig();
  if (!config.cloudName) return false;

  const publicId = urlOrPublicId.includes('cloudinary.com')
    ? extractCloudinaryPublicId(urlOrPublicId)
    : urlOrPublicId;

  if (!publicId) return false;

  const apiKey = import.meta.env.PUBLIC_CLOUDINARY_API_KEY || (typeof window !== 'undefined' ? localStorage.getItem('senati_cloudinary_api_key') : '') || '';
  const apiSecret = import.meta.env.PUBLIC_CLOUDINARY_API_SECRET || (typeof window !== 'undefined' ? localStorage.getItem('senati_cloudinary_api_secret') : '') || '';

  if (apiKey && apiSecret) {
    try {
      const timestamp = Math.floor(Date.now() / 1000);
      const strToSign = `public_id=${publicId}&timestamp=${timestamp}${apiSecret}`;
      const signature = await sha1Hex(strToSign);

      const resourceType = mediaType === 'video' ? 'video' : 'image';
      const formData = new FormData();
      formData.append('public_id', publicId);
      formData.append('api_key', apiKey);
      formData.append('timestamp', String(timestamp));
      formData.append('signature', signature);

      const res = await fetch(`https://api.cloudinary.com/v1_1/${config.cloudName}/${resourceType}/destroy`, {
        method: 'POST',
        body: formData
      });

      const json = await res.json();
      console.log('Resultado de eliminación en Cloudinary:', json);
      return json?.result === 'ok';
    } catch (e) {
      console.warn('Error al eliminar en Cloudinary:', e);
      return false;
    }
  } else {
    console.info('Para eliminar archivos en Cloudinary desde el navegador, agrega PUBLIC_CLOUDINARY_API_KEY y PUBLIC_CLOUDINARY_API_SECRET en .env');
  }

  return false;
}
