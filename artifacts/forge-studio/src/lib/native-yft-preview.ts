import { MAX_FILE_SIZE } from '@/lib/model-io';

export type NativeYftPreview = {
  model: File;
  meshCount: number;
  skippedMeshCount: number;
  textureCount: number;
  usedTextures: string[];
};

async function toBase64(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const step = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += step) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + step, bytes.length)));
  }
  return btoa(binary);
}

function fromBase64(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export async function previewNativeYft(modelFile: File, textureFiles: File[] = []): Promise<NativeYftPreview> {
  if (textureFiles.length > 24) throw new Error('Choose up to 24 matching YTD texture dictionaries.');
  const totalBytes = modelFile.size + textureFiles.reduce((total, file) => total + file.size, 0);
  if (totalBytes > MAX_FILE_SIZE) throw new Error('The YFT and its texture dictionaries exceed the 250 MB preview limit.');

  const [modelBase64, textureDictionaries] = await Promise.all([
    toBase64(modelFile),
    Promise.all(textureFiles.map(async (file) => ({
      name: file.webkitRelativePath || file.name,
      dataBase64: await toBase64(file),
    }))),
  ]);
  const response = await fetch('/api/native-assets/preview-yft', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fileName: modelFile.webkitRelativePath || modelFile.name,
      modelBase64,
      textureDictionaries,
    }),
  });
  const data = await response.json() as {
    error?: string;
    modelBase64?: string;
    meshCount?: number;
    skippedMeshCount?: number;
    textureCount?: number;
    usedTextures?: string[];
  };
  if (!response.ok) throw new Error(data.error || 'The YFT could not be converted for preview.');
  if (!data.modelBase64 || !data.meshCount) throw new Error('The YFT reader returned an empty model preview.');

  const modelName = modelFile.name.replace(/\.[^.]+$/, '') || 'vehicle';
  return {
    model: new File([fromBase64(data.modelBase64)], `${modelName}.glb`, { type: 'model/gltf-binary' }),
    meshCount: data.meshCount,
    skippedMeshCount: data.skippedMeshCount || 0,
    textureCount: data.textureCount || 0,
    usedTextures: data.usedTextures || [],
  };
}
