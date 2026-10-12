import JSZip from 'jszip';

export type ResourceFileKind = 'native' | 'meta' | 'manifest' | 'script' | 'other';

export type ResourcePackageFile = {
  path: string;
  file: File;
  kind: ResourceFileKind;
};

export type ResourcePackage = {
  name: string;
  files: ResourcePackageFile[];
  hasManifest: boolean;
};

const NATIVE_EXTENSIONS = new Set([
  'yft', 'ytd', 'ydr', 'ydd', 'ybn', 'ytyp', 'ymap', 'ymf', 'ycd', 'ymt', 'yld', 'ypt',
]);
const MAX_FILE_SIZE = 250 * 1024 * 1024;
const MAX_FILES = 2000;
const MAX_TOTAL_SIZE = 350 * 1024 * 1024;
const DATA_FILE_TYPES: Record<string, string> = {
  'vehicles.meta': 'VEHICLE_METADATA_FILE',
  'handling.meta': 'HANDLING_FILE',
  'carcols.meta': 'CARCOLS_FILE',
  'carvariations.meta': 'VEHICLE_VARIATION_FILE',
  'vehiclelayouts.meta': 'VEHICLE_LAYOUTS_FILE',
  'contentunlocks.meta': 'CONTENT_UNLOCKING_META_FILE',
};

function extension(path: string) {
  return path.split('/').pop()?.split('.').pop()?.toLowerCase() || '';
}

function fileKind(path: string): ResourceFileKind {
  const name = path.split('/').pop()?.toLowerCase() || '';
  const ext = extension(path);
  if (NATIVE_EXTENSIONS.has(ext)) return 'native';
  if (ext === 'meta') return 'meta';
  if (name === 'fxmanifest.lua' || name === '__resource.lua') return 'manifest';
  if (['lua', 'json', 'cfg', 'txt'].includes(ext)) return 'script';
  return 'other';
}

function safePath(input: string) {
  const path = input.replace(/\\/g, '/');
  if (!path || path.startsWith('/') || /^[a-z]:/i.test(path) || /[\u0000-\u001f]/.test(path) || path.split('/').includes('..')) {
    throw new Error('The package contains an unsafe file path and was not imported.');
  }
  const clean = path.split('/').filter((part) => part && part !== '.').join('/');
  if (!clean || clean.length > 1024) throw new Error('The package contains an invalid or excessively long file path.');
  return clean;
}

function commonResourceRoot(paths: string[]) {
  const manifests = paths.filter((path) => ['fxmanifest.lua', '__resource.lua'].includes(path.split('/').pop()?.toLowerCase() || ''));
  if (manifests.length === 1) {
    const dir = manifests[0].slice(0, manifests[0].lastIndexOf('/'));
    if (dir) return `${dir}/`;
  }

  const firstSegments = paths.map((path) => path.split('/')[0]);
  const [first] = firstSegments;
  if (first && firstSegments.every((segment) => segment.toLowerCase() === first.toLowerCase()) && first.toLowerCase() !== 'stream' &&
      paths.some((path) => path.toLowerCase().startsWith(`${first.toLowerCase()}/stream/`) || path.toLowerCase().startsWith(`${first.toLowerCase()}/data/`))) {
    return `${first}/`;
  }
  return '';
}

function cleanMacMetadata(path: string) {
  return path === '.DS_Store' || path.startsWith('__MACOSX/');
}

function directoryImportName(files: File[]) {
  const firstPath = files[0]?.webkitRelativePath || files[0]?.name || 'vehicle_resource';
  const first = firstPath.split('/')[0];
  return first.replace(/\.zip$/i, '') || 'vehicle_resource';
}

export async function readResourcePackage(
  inputFiles: File[],
  onProgress?: (completed: number, total: number, label: string) => void,
): Promise<ResourcePackage> {
  if (!inputFiles.length) throw new Error('Choose a FiveM ZIP or a resource folder to import.');

  const rawFiles: Array<{ path: string; file: File }> = [];
  for (const input of inputFiles) {
    if (/\.zip$/i.test(input.name)) {
      let archive: JSZip;
      try {
        archive = await JSZip.loadAsync(input);
      } catch (error) {
        throw new Error(`Could not open “${input.name}” as a ZIP archive: ${error instanceof Error ? error.message : 'invalid archive'}`);
      }
      const entries = Object.values(archive.files).filter((entry) => !entry.dir);
      if (entries.length > MAX_FILES) {
        throw new Error(`“${input.name}” contains more than ${MAX_FILES.toLocaleString()} files. Split the resource and try again.`);
      }
      let declaredTotal = 0;
      const prepared = entries.map((entry) => {
        const originalPath = (entry as unknown as { unsafeOriginalName?: string }).unsafeOriginalName || entry.name;
        const path = safePath(originalPath);
        const declaredSize = (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
        if (typeof declaredSize !== 'number' || !Number.isFinite(declaredSize) || declaredSize < 0) {
          throw new Error(`Could not safely inspect “${path}” inside “${input.name}”.`);
        }
        if (declaredSize > MAX_FILE_SIZE) throw new Error(`“${path}” is larger than 250 MB.`);
        declaredTotal += declaredSize;
        if (declaredTotal > MAX_TOTAL_SIZE) throw new Error(`“${input.name}” expands beyond the 350 MB safety limit.`);
        return { entry, path };
      }).filter(({ path }) => !cleanMacMetadata(path));

      let actualTotal = 0;
      for (let index = 0; index < prepared.length; index++) {
        const { entry, path } = prepared[index];
        const bytes = await entry.async('uint8array');
        actualTotal += bytes.byteLength;
        if (actualTotal > MAX_TOTAL_SIZE) throw new Error(`“${input.name}” expands beyond the 350 MB safety limit.`);
        const leaf = path.split('/').pop() || path;
        rawFiles.push({ path, file: new File([bytes.slice().buffer as ArrayBuffer], leaf, { type: 'application/octet-stream' }) });
        onProgress?.(index + 1, prepared.length, input.name);
      }
    } else {
      rawFiles.push({ path: safePath(input.webkitRelativePath || input.name), file: input });
    }
  }

  if (rawFiles.length > MAX_FILES) throw new Error(`This resource contains more than ${MAX_FILES.toLocaleString()} files.`);
  let totalSize = 0;
  for (const item of rawFiles) {
    if (item.file.size > MAX_FILE_SIZE) throw new Error(`“${item.path}” is larger than 250 MB.`);
    totalSize += item.file.size;
    if (totalSize > MAX_TOTAL_SIZE) throw new Error('This resource exceeds the 350 MB unpacked size limit.');
  }
  if (!rawFiles.length) throw new Error('The selected ZIP or folder contains no files.');

  const rootPrefix = commonResourceRoot(rawFiles.map((item) => item.path));
  const seen = new Set<string>();
  const files = rawFiles
    .filter((item) => !cleanMacMetadata(item.path))
    .map(({ path, file }) => {
      const relativePath = rootPrefix && path.toLowerCase().startsWith(rootPrefix.toLowerCase())
        ? path.slice(rootPrefix.length)
        : path;
      const normalized = safePath(relativePath);
      const duplicateKey = normalized.toLocaleLowerCase();
      if (seen.has(duplicateKey)) throw new Error(`The package contains duplicate file paths: “${normalized}”.`);
      seen.add(duplicateKey);
      return { path: normalized, file, kind: fileKind(normalized) };
    });

  const hasManifest = files.some((item) => item.kind === 'manifest');
  const hasGameAssets = files.some((item) => item.kind === 'native');
  const hasFiveMMetadata = files.some((item) => item.kind === 'meta');
  if (!hasManifest && !hasGameAssets && !hasFiveMMetadata) {
    throw new Error('No FiveM resource files were found. Choose a folder or ZIP containing GTA assets, .meta files, or fxmanifest.lua.');
  }

  const zippedName = inputFiles.find((file) => /\.zip$/i.test(file.name))?.name.replace(/\.zip$/i, '');
  return {
    name: zippedName || directoryImportName(inputFiles),
    files,
    hasManifest,
  };
}

function escapedLuaString(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function pathForGeneratedResource(item: ResourcePackageFile) {
  if (item.kind === 'native' && !item.path.toLowerCase().startsWith('stream/')) return `stream/${item.path}`;
  if (item.kind === 'meta' && !item.path.toLowerCase().startsWith('data/')) return `data/${item.path}`;
  return item.path;
}

function generateManifest(files: Array<{ path: string; kind: ResourceFileKind }>) {
  const metadata = files
    .map((item) => {
      const leaf = item.path.split('/').pop()?.toLowerCase() || '';
      const type = DATA_FILE_TYPES[leaf] || (leaf.endsWith('.ytyp') ? 'DLC_ITYP_REQUEST' : undefined);
      return { ...item, type };
    })
    .filter((item): item is { path: string; kind: ResourceFileKind; type: string } => Boolean(item.type));
  const lines = ["fx_version 'cerulean'", "game 'gta5'"];
  if (metadata.length) {
    lines.push('', 'files {', ...metadata.map(({ path }) => `  '${escapedLuaString(path)}',`), '}');
    for (const item of metadata) lines.push(`data_file '${item.type}' '${escapedLuaString(item.path)}'`);
  }
  return `${lines.join('\n')}\n`;
}

export async function buildFiveMResourceZip(resource: ResourcePackage) {
  const zip = new JSZip();
  const outputFiles = resource.hasManifest
    ? resource.files.map((item) => ({ ...item, outputPath: item.path }))
    : resource.files.map((item) => ({ ...item, outputPath: pathForGeneratedResource(item) }));

  for (const item of outputFiles) zip.file(item.outputPath, item.file);
  if (!resource.hasManifest) {
    zip.file('fxmanifest.lua', generateManifest(outputFiles.map(({ outputPath, kind }) => ({ path: outputPath, kind }))));
  }
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}
