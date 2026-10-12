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
export const MAX_FILE_SIZE = 250 * 1024 * 1024;

export function extension(file: File) { return file.name.split('.').pop()?.toLowerCase() || ''; }
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
  const manager = new THREE.LoadingManager();
  const urls = new Map<string, string>();
  files.forEach((file) => urls.set(file.name.toLowerCase(), URL.createObjectURL(file)));
  manager.setURLModifier((url) => {
    const clean = decodeURIComponent(url).split(/[\\/]/).pop()?.toLowerCase() || '';
    if (urls.has(clean)) return urls.get(clean)!;
    if (url.startsWith('data:')) return url;
    throw new Error(`Missing local sidecar “${clean || url}”. External URLs are blocked.`);
  });
  const buffer = await model.arrayBuffer();
  let root: THREE.Object3D;
  if (ext === 'glb' || ext === 'gltf') {
    const loader = new GLTFLoader(manager);
    const parsed = await new Promise<any>((resolve, reject) =>
      loader.parse(buffer, '', resolve, reject),
    );
    root = parsed.scene;
  } else if (ext === 'obj') {
    const mtlFile = files.find((file) => extension(file) === 'mtl');
    const loader = new OBJLoader(manager);
    if (mtlFile) {
      const mtlText = await mtlFile.text();
      const mtl = new MTLLoader(manager).parse(mtlText, '');
      mtl.preload();
      loader.setMaterials(mtl);
    }
    root = loader.parse(new TextDecoder().decode(buffer));
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
  window.setTimeout(() => urls.forEach((url) => URL.revokeObjectURL(url)), 30000);
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
