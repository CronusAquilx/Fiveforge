import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { OBJExporter } from 'three/examples/jsm/exporters/OBJExporter.js';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import JSZip from 'jszip';

export type LoadedAsset = { root: THREE.Object3D; name: string; format: string; source: File[] };
const accepted = ['glb', 'gltf', 'obj', 'stl'];
const archiveAssets = new Set([...accepted, 'mtl', 'bin', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp']);
export const MAX_FILE_SIZE = 250 * 1024 * 1024;
const MAX_ARCHIVE_FILES = 2000;
const MAX_ARCHIVE_ENTRY_SIZE = MAX_FILE_SIZE;
const MAX_ARCHIVE_UNPACKED_SIZE = 350 * 1024 * 1024;

type AssetFile = File & { forgePath?: string };

function extensionFromName(name: string) { return name.split('.').pop()?.toLowerCase() || ''; }
export function extension(file: File) { return extensionFromName(file.name); }

function assetPath(file: File) {
  const asset = file as AssetFile;
  return (asset.forgePath || file.webkitRelativePath || file.name).replace(/\\/g, '/');
}

function directoryOf(path: string) {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash + 1);
}

function normalizeAssetPath(path: string, base = '') {
  let decoded = path;
  try { decoded = decodeURIComponent(path); } catch { /* Keep literal percent signs in file names. */ }
  const joined = decoded.replace(/\\/g, '/').startsWith('/')
    ? decoded.replace(/\\/g, '/').slice(1)
    : `${base}${decoded.replace(/\\/g, '/')}`;
  const parts: string[] = [];
  for (const part of joined.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) throw new Error('A model resource path escapes its local package.');
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join('/').toLowerCase();
}

function safeArchivePath(path: string) {
  const normalized = path.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[a-z]:/i.test(normalized) || normalized.split('/').includes('..')) {
    throw new Error('The ZIP contains an unsafe file path and was not opened.');
  }
  const clean = normalized.split('/').filter((part) => part && part !== '.').join('/');
  if (!clean || clean.length > 1024) throw new Error('The ZIP contains an invalid or excessively long file path.');
  return clean;
}

function mimeForExtension(ext: string) {
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'bmp') return 'image/bmp';
  if (ext === 'mtl') return 'text/plain';
  if (ext === 'gltf') return 'model/gltf+json';
  if (ext === 'obj') return 'text/plain';
  if (ext === 'stl') return 'model/stl';
  if (ext === 'glb') return 'model/gltf-binary';
  return 'application/octet-stream';
}

export async function expandArchives(
  files: File[],
  onProgress?: (completed: number, total: number, archiveName: string) => void,
) {
  const expanded: File[] = [];
  for (const file of files) {
    if (extension(file) !== 'zip') {
      expanded.push(file);
      continue;
    }

    let archive: JSZip;
    try {
      archive = await JSZip.loadAsync(file);
    } catch (error) {
      throw new Error(`Could not open “${file.name}” as a ZIP archive: ${error instanceof Error ? error.message : 'invalid archive'}`);
    }

    const allEntries = Object.values(archive.files).filter((entry) => !entry.dir);
    if (allEntries.length > MAX_ARCHIVE_FILES) {
      throw new Error(`“${file.name}” contains more than ${MAX_ARCHIVE_FILES.toLocaleString()} files. Split the package and try again.`);
    }

    const nativeEntry = allEntries.find((entry) => ['yft', 'ytd', 'ydr', 'ydd', 'ybn'].includes(extensionFromName(entry.name)));
    const relevant = allEntries.filter((entry) => archiveAssets.has(extensionFromName(entry.name)));
    if (!relevant.some((entry) => accepted.includes(extensionFromName(entry.name)))) {
      if (nativeEntry) {
        throw new Error(`${extensionFromName(nativeEntry.name).toUpperCase()} is a native GTA format and is not supported here. No game-format converter is installed.`);
      }
      throw new Error(`No supported 3D model was found in “${file.name}”. Include a GLB, GLTF, OBJ or STL file.`);
    }

    let declaredTotal = 0;
    const paths = relevant.map((entry) => {
      const originalName = (entry as unknown as { unsafeOriginalName?: string }).unsafeOriginalName || entry.name;
      const path = safeArchivePath(originalName);
      const declaredSize = (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
      if (typeof declaredSize !== 'number' || !Number.isFinite(declaredSize) || declaredSize < 0) {
        throw new Error(`Could not safely inspect “${path}” inside “${file.name}”.`);
      }
      if (declaredSize > MAX_ARCHIVE_ENTRY_SIZE) {
        throw new Error(`“${path}” is larger than ${Math.round(MAX_ARCHIVE_ENTRY_SIZE / 1024 / 1024)} MB.`);
      }
      declaredTotal += declaredSize;
      return path;
    });
    if (declaredTotal > MAX_ARCHIVE_UNPACKED_SIZE) {
      throw new Error(`“${file.name}” expands beyond the ${Math.round(MAX_ARCHIVE_UNPACKED_SIZE / 1024 / 1024)} MB safety limit.`);
    }

    let actualTotal = 0;
    for (let index = 0; index < relevant.length; index++) {
      const entry = relevant[index];
      const path = paths[index];
      const bytes = await entry.async('uint8array');
      actualTotal += bytes.byteLength;
      if (actualTotal > MAX_ARCHIVE_UNPACKED_SIZE) {
        throw new Error(`“${file.name}” expands beyond the ${Math.round(MAX_ARCHIVE_UNPACKED_SIZE / 1024 / 1024)} MB safety limit.`);
      }
      const data = bytes.slice().buffer as ArrayBuffer;
      const unpacked = new File([data], path.split('/').pop()!, { type: mimeForExtension(extensionFromName(path)) });
      Object.defineProperty(unpacked, 'forgePath', { value: path });
      expanded.push(unpacked as AssetFile);
      onProgress?.(index + 1, relevant.length, file.name);
    }
  }
  return expanded;
}

export function validateFiles(files: File[]) {
  if (!files.length) throw new Error('Choose at least one supported model file.');
  const model = files.find((f) => accepted.includes(extension(f)));
  if (!model) {
    const native = files.find((file) => ['yft', 'ytd', 'ydr', 'ydd', 'ybn'].includes(extension(file)));
    if (native) throw new Error(`${extension(native).toUpperCase()} is a native GTA format and is not supported here. No game-format converter is installed.`);
    throw new Error('Unsupported format. Forge Studio accepts GLB, GLTF, OBJ and STL.');
  }
  if (files.some((f) => f.size > MAX_FILE_SIZE)) throw new Error('Files must be smaller than 250 MB.');
  return model;
}

export async function loadAsset(files: File[]): Promise<LoadedAsset> {
  const model = validateFiles(files);
  const ext = extension(model);
  const modelPath = assetPath(model);
  const modelDirectory = directoryOf(modelPath);
  const manager = new THREE.LoadingManager();
  const urlsByPath = new Map<string, string>();
  const urlsByName = new Map<string, string[]>();
  files.forEach((file) => {
    const path = normalizeAssetPath(assetPath(file));
    if (urlsByPath.has(path)) throw new Error(`The import contains duplicate local file paths named “${path}”.`);
    const url = URL.createObjectURL(file);
    urlsByPath.set(path, url);
    const name = path.split('/').pop()!;
    urlsByName.set(name, [...(urlsByName.get(name) || []), url]);
  });
  manager.setURLModifier((url) => {
    if (url.startsWith('data:')) return url;
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(url)) throw new Error('External model resources are blocked. Import the required files with the model.');
    const resourcePath = url.split(/[?#]/, 1)[0];
    const resolved = normalizeAssetPath(resourcePath, modelDirectory);
    const exact = urlsByPath.get(resolved);
    if (exact) return exact;
    const name = normalizeAssetPath(resourcePath).split('/').pop() || '';
    const matches = urlsByName.get(name) || [];
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw new Error(`The resource “${name}” is ambiguous. Keep sidecar names unique within the ZIP package.`);
    throw new Error(`Missing local sidecar “${name || url}”. Add it to the ZIP with the model.`);
  });
  const buffer = await model.arrayBuffer();
  let root: THREE.Object3D;
  if (ext === 'glb' || ext === 'gltf') {
    const loader = new GLTFLoader(manager);
    const parsed = await new Promise<any>((resolve, reject) =>
      loader.parse(buffer, modelDirectory, resolve, reject),
    );
    root = parsed.scene;
  } else if (ext === 'obj') {
    const objText = new TextDecoder().decode(buffer);
    const materialLibrary = objText.match(/^\s*mtllib\s+(.+?)\s*$/im)?.[1]?.trim();
    const mtlPath = materialLibrary ? normalizeAssetPath(materialLibrary, modelDirectory) : '';
    const mtlMatches = files.filter((file) => extension(file) === 'mtl' && (
      (mtlPath && normalizeAssetPath(assetPath(file)) === mtlPath) ||
      (!materialLibrary && extension(file) === 'mtl')
    ));
    if (mtlMatches.length > 1) throw new Error('This OBJ package has multiple possible MTL files. Add a matching “mtllib” entry or import one model at a time.');
    const mtlFile = mtlMatches[0];
    const loader = new OBJLoader(manager);
    if (mtlFile) {
      const mtlText = await mtlFile.text();
      const mtl = new MTLLoader(manager).parse(mtlText, directoryOf(assetPath(mtlFile)));
      mtl.preload();
      loader.setMaterials(mtl);
    }
    root = loader.parse(objText);
    root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      const convert = (material: THREE.Material) => {
        const phong = material as THREE.MeshPhongMaterial;
        if (!phong.color) return material;
        if (phong.map) phong.map.colorSpace = THREE.SRGBColorSpace;
        return new THREE.MeshStandardMaterial({
          name: phong.name,
          color: phong.color,
          map: phong.map,
          bumpMap: phong.bumpMap,
          bumpScale: phong.bumpScale,
          alphaMap: phong.alphaMap,
          opacity: phong.opacity,
          transparent: phong.transparent,
          side: phong.side,
          roughness: THREE.MathUtils.clamp(Math.sqrt(2 / (Math.max(0, phong.shininess) + 2)), 0.08, 1),
          metalness: 0.04,
        });
      };
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(convert) : convert(mesh.material);
    });
  } else {
    const geometry = new STLLoader(manager).parse(buffer);
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0x9b9b98, metalness: 0.16, roughness: 0.58 }));
    mesh.name = model.name.replace(/\.[^.]+$/, '');
    root = mesh;
  }
  root.name ||= model.name.replace(/\.[^.]+$/, '');
  root.updateMatrixWorld(true);
  window.setTimeout(() => urlsByPath.forEach((url) => URL.revokeObjectURL(url)), 30000);
  return { root, name: model.name.replace(/\.[^.]+$/, ''), format: ext.toUpperCase(), source: files };
}

export async function exportModel(root: THREE.Object3D, format: 'glb' | 'gltf' | 'obj' | 'stl') {
  if (format === 'glb' || format === 'gltf') {
    const exporter = new GLTFExporter();
    const data = await new Promise<ArrayBuffer | object>((resolve, reject) =>
      exporter.parse(root, resolve, reject, { binary: format === 'glb', embedImages: true, onlyVisible: true }),
    );
    if (format === 'glb') return new Blob([data as ArrayBuffer], { type: 'model/gltf-binary' });
    const zip = new JSZip();
    zip.file('scene.gltf', JSON.stringify(data, null, 2));
    return zip.generateAsync({ type: 'blob' });
  }
  if (format === 'obj') {
    const materials: THREE.Material[] = [];
    root.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh) return;
      (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach((material) => {
        if (!materials.includes(material)) materials.push(material);
      });
    });
    const originalNames = materials.map((material) => material.name);
    const exportNames = materials.map((material, index) => material.name || `Material_${index + 1}`);
    materials.forEach((material, index) => { material.name = exportNames[index]; });
    const objData = new OBJExporter().parse(root);
    const zip = new JSZip();
    zip.file('scene.obj', `mtllib scene.mtl\n${objData}`);
    const mtl: string[] = ['# Companion material library for scene.obj'];
    for (const [index, material] of materials.entries()) {
      const surface = material as THREE.MeshStandardMaterial;
      const color = surface.color?.clone().convertLinearToSRGB();
      mtl.push(`newmtl ${exportNames[index]}`);
      if (color) mtl.push(`Kd ${color.r.toFixed(5)} ${color.g.toFixed(5)} ${color.b.toFixed(5)}`);
      mtl.push('Ka 0.04 0.04 0.04');
      const metalness = surface.metalness ?? 0;
      mtl.push(`Ks ${(0.08 + metalness * 0.42).toFixed(5)} ${(0.08 + metalness * 0.42).toFixed(5)} ${(0.08 + metalness * 0.42).toFixed(5)}`);
      mtl.push(`Ns ${Math.round((1 - (surface.roughness ?? 0.7)) * 900)}`);
      const map = surface.map;
      if (map?.image) {
        const name = `texture_${map.id}.png`;
        const image = map.image as CanvasImageSource & { width?: number; height?: number; videoWidth?: number; videoHeight?: number };
        const canvas = document.createElement('canvas');
        canvas.width = image.width || image.videoWidth || 1;
        canvas.height = image.height || image.videoHeight || 1;
        const context = canvas.getContext('2d');
        if (context) {
          context.drawImage(image, 0, 0);
          const imageBlob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
          if (imageBlob) {
            zip.file(name, imageBlob);
            mtl.push(`map_Kd ${name}`);
          }
        }
      }
      mtl.push('');
    }
    materials.forEach((material, index) => { material.name = originalNames[index]; });
    zip.file('scene.mtl', mtl.join('\n'));
    return zip.generateAsync({ type: 'blob' });
  }
  const data = new STLExporter().parse(root, { binary: true });
  const view = data as DataView;
  return new Blob([Uint8Array.from(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)).buffer as ArrayBuffer], { type: 'model/stl' });
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
