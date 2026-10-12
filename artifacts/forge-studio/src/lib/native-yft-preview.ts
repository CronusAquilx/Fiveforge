import { MAX_FILE_SIZE } from '@/lib/model-io';

export type NativeYftPreview = {
  model: File;
  meshCount: number;
  skippedMeshCount: number;
  textureCount: number;
  usedTextures: string[];
  unmatchedTextures: string[];
  textureErrors: string[];
  gtaShaders: string[];
};

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

  const files = [
    { name: modelFile.name, role: 'model', file: modelFile },
    ...textureFiles.map((file) => ({ name: file.webkitRelativePath || file.name, role: 'texture', file })),
  ];
  const header = new TextEncoder().encode(JSON.stringify({
    fileName: modelFile.webkitRelativePath || modelFile.name,
    files: files.map(({ name, role, file }) => ({ name, role, size: file.size })),
  }));
  const headerLength = new Uint8Array(4);
  new DataView(headerLength.buffer).setUint32(0, header.byteLength, false);
  const body = new Blob([headerLength, header, ...files.map(({ file }) => file)], { type: 'application/octet-stream' });

  const response = await fetch('/api/native-assets/preview-yft-binary', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body,
  });
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(errorData.error || 'The YFT could not be converted for preview.');
  }
  const metadataHeader = response.headers.get('X-Forge-Preview-Metadata');
  if (!metadataHeader) throw new Error('The YFT reader returned missing preview details.');
  let data: {
    error?: string;
    fileName?: string;
    meshCount?: number;
    skippedMeshCount?: number;
    textureCount?: number;
    usedTextures?: string[];
    unmatchedTextures?: string[];
    textureErrors?: string[];
    gtaShaders?: string[];
  };
  try {
    data = JSON.parse(new TextDecoder().decode(fromBase64(metadataHeader))) as typeof data;
  } catch {
    throw new Error('The YFT reader returned invalid preview details.');
  }
  const modelBytes = await response.arrayBuffer();
  if (!modelBytes.byteLength || !data.meshCount) throw new Error('The YFT reader returned an empty model preview.');

  const modelName = modelFile.name.replace(/\.[^.]+$/, '') || 'vehicle';
  return {
    model: new File([modelBytes], `${modelName}.glb`, { type: 'model/gltf-binary' }),
    meshCount: data.meshCount,
    skippedMeshCount: data.skippedMeshCount || 0,
    textureCount: data.textureCount || 0,
    usedTextures: data.usedTextures || [],
    unmatchedTextures: data.unmatchedTextures || [],
    textureErrors: data.textureErrors || [],
    gtaShaders: data.gtaShaders || [],
  };
}
