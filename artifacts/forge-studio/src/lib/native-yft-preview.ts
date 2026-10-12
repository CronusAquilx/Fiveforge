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
  extras: NativeYftExtra[];
  meshExtras: string[];
  nativeMeshLod: string;
  nativeMeshMap: NativeYftMeshMap[];
};

export type NativeYftExtra = { id: string; label: string };
export type NativeYftMeshMap = { meshIndex: number; label: string; nodeCount: number };
export type NativeYftMeshEdit = { meshIndex: number; matrix?: number[]; removed: boolean };

function fromBase64(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function binaryBundle(files: Array<{ name: string; role: string; file: File }>) {
  const header = new TextEncoder().encode(JSON.stringify({
    fileName: files[0]?.name || 'vehicle.yft',
    files: files.map(({ name, role, file }) => ({ name, role, size: file.size })),
  }));
  const headerLength = new Uint8Array(4);
  new DataView(headerLength.buffer).setUint32(0, header.byteLength, false);
  return new Blob([headerLength, header, ...files.map(({ file }) => file)], { type: 'application/octet-stream' });
}

export async function previewNativeYft(modelFile: File, textureFiles: File[] = []): Promise<NativeYftPreview> {
  if (textureFiles.length > 24) throw new Error('Choose up to 24 matching YTD texture dictionaries.');
  const totalBytes = modelFile.size + textureFiles.reduce((total, file) => total + file.size, 0);
  if (totalBytes > MAX_FILE_SIZE) throw new Error('The YFT and its texture dictionaries exceed the 250 MB preview limit.');

  const files = [
    { name: modelFile.name, role: 'model', file: modelFile },
    ...textureFiles.map((file) => ({ name: file.webkitRelativePath || file.name, role: 'texture', file })),
  ];
  const body = binaryBundle(files);

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
    extras?: NativeYftExtra[];
    meshExtras?: string[];
    nativeMeshLod?: string;
    nativeMeshMap?: NativeYftMeshMap[];
  };
  try {
    data = JSON.parse(new TextDecoder().decode(fromBase64(metadataHeader))) as typeof data;
  } catch {
    throw new Error('The YFT reader returned invalid preview details.');
  }
  if (!Array.isArray(data.extras) || !Array.isArray(data.meshExtras) || !Array.isArray(data.nativeMeshMap)) {
    throw new Error('The YFT reader did not return its native mesh map.');
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
    extras: data.extras,
    meshExtras: data.meshExtras,
    nativeMeshLod: data.nativeMeshLod || 'unknown',
    nativeMeshMap: data.nativeMeshMap,
  };
}

export async function rebuildNativeYft(
  files: Array<{ path: string; file: File }>,
  sourcePath: string,
  sourceLod: string,
  edits: NativeYftMeshEdit[],
): Promise<{ files: Array<{ path: string; file: File }>; editsApplied: number; warnings: string[] }> {
  if (!files.length || files.length > 24) throw new Error('Choose up to 24 matching YFT files for native export.');
  const totalBytes = files.reduce((total, item) => total + item.file.size, 0);
  if (totalBytes > MAX_FILE_SIZE) throw new Error('The related YFT files exceed the 250 MB native export limit.');
  if (!edits.length) return { files: [], editsApplied: 0, warnings: [] };

  const header = new TextEncoder().encode(JSON.stringify({
    sourcePath,
    sourceLod,
    edits,
    files: files.map(({ path, file }) => ({ name: path, role: 'model', size: file.size })),
  }));
  const headerLength = new Uint8Array(4);
  new DataView(headerLength.buffer).setUint32(0, header.byteLength, false);
  const body = new Blob([headerLength, header, ...files.map(({ file }) => file)], { type: 'application/octet-stream' });
  const response = await fetch('/api/native-assets/rebuild-yft-binary', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body,
  });
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(errorData.error || 'The native YFT files could not be rebuilt.');
  }
  const metadataHeader = response.headers.get('X-Forge-Rebuild-Metadata');
  if (!metadataHeader) throw new Error('The native YFT writer returned missing rebuild details.');

  let metadata: { files?: Array<{ path: string; size: number }>; editsApplied?: number; warnings?: string[] };
  try {
    metadata = JSON.parse(new TextDecoder().decode(fromBase64(metadataHeader))) as typeof metadata;
  } catch {
    throw new Error('The native YFT writer returned invalid rebuild details.');
  }
  if (
    !Array.isArray(metadata.files)
    || metadata.files.length !== files.length
    || metadata.files.some((item) => !item || typeof item.path !== 'string' || !Number.isInteger(item.size) || item.size < 1)
  ) {
    throw new Error('The native YFT writer returned an incomplete file list.');
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const expectedBytes = metadata.files.reduce((total, item) => total + item.size, 0);
  if (!bytes.length || bytes.length !== expectedBytes) throw new Error('The native YFT writer returned an incomplete binary result.');
  const rebuiltFiles: Array<{ path: string; file: File }> = [];
  let offset = 0;
  for (const item of metadata.files) {
    const source = files.find((candidate) => candidate.path.toLowerCase() === item.path.toLowerCase());
    if (!source) throw new Error(`The native YFT writer returned an unexpected file: ${item.path}`);
    const fileBytes = bytes.slice(offset, offset + item.size);
    offset += item.size;
    rebuiltFiles.push({
      path: item.path,
      file: new File([fileBytes], source.file.name, { type: 'application/octet-stream' }),
    });
  }
  return {
    files: rebuiltFiles,
    editsApplied: Number(metadata.editsApplied) || edits.length,
    warnings: Array.isArray(metadata.warnings) ? metadata.warnings.filter((item) => typeof item === 'string') : [],
  };
}

export async function inspectNativeYftExtras(modelFile: File): Promise<NativeYftExtra[]> {
  if (modelFile.size > MAX_FILE_SIZE) throw new Error('The YFT file exceeds the 250 MB inspection limit.');
  const body = binaryBundle([{
    name: modelFile.webkitRelativePath || modelFile.name,
    role: 'model',
    file: modelFile,
  }]);
  const response = await fetch('/api/native-assets/inspect-yft-extras-binary', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body,
  });
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(errorData.error || `Could not inspect extras in ${modelFile.name}.`);
  }
  const data = await response.json() as { extras?: NativeYftExtra[] };
  if (!Array.isArray(data.extras) || data.extras.some((extra) => !extra || typeof extra.id !== 'string' || typeof extra.label !== 'string')) {
    throw new Error(`The YFT reader returned an invalid extra list for ${modelFile.name}.`);
  }
  return data.extras;
}
