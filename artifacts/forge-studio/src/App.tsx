import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import {
  Activity, ArrowDownToLine, Axis3D, Box, Check, ChevronDown, ChevronRight, CircleHelp,
  Copy, Download, Eye, EyeOff, FilePlus2, FolderOpen, Grid2X2, HardDrive,
  ImagePlus, Layers3, LockKeyhole, Menu, Move3D, PanelLeftClose, PanelRightClose,
  Plus, RotateCcw, RotateCw, Save, Search, Settings2, ShieldCheck, Trash2, Upload,
  X, ZoomIn,
} from 'lucide-react';
import { Viewport } from '@/components/Viewport';
import ResourcePackageDialog from '@/components/ResourcePackageDialog';
import NativeTextureStudioDialog from '@/components/NativeTextureStudioDialog';
import VehiclePartsPanel, { type VehiclePartControl } from '@/components/VehiclePartsPanel';
import './native-texture-studio.css';
import './vehicle-parts.css';
import './viewport-tools.css';
import { downloadBlob, expandArchives, exportModel, loadAsset, MAX_FILE_SIZE, validateFiles } from '@/lib/model-io';
import { getProject, listProjects, saveProject, type LocalProject } from '@/lib/projects';
import { buildFiveMResourceZip, readResourcePackage, type ResourcePackage, type ResourcePackageFile } from '@/lib/resource-package';
import { inspectNativeYftExtras, previewNativeYft, type NativeYftExtra } from '@/lib/native-yft-preview';

type Notice = { kind: 'success' | 'error' | 'info'; message: string } | null;
type Busy = { label: string; progress: number } | null;
type VehicleAddonPart = VehiclePartControl & { file: File };
type VehicleExtraSource = NativeYftExtra & { sources: string[] };
type InlineVehiclePart = Pick<VehiclePartControl, 'id' | 'label'> & { category: 'extra' | 'inline' };
const supported = '.glb,.gltf,.obj,.stl,.mtl,.png,.jpg,.jpeg,.webp,.yft,.ytd,.ydr,.ydd,.ybn,.ytyp,.ymap,.ymf,.ycd,.ymt,.yld,.ypt,.meta,.lua,.zip';
const unsupportedGame = ['YFT', 'YTD', 'YDR', 'YDD', 'YBN', 'YTYP', 'YMAP'];

function normalizeYftStem(path: string) {
  return (path.split('/').pop() || path).replace(/\.yft$/i, '').replace(/_(?:hi|med|low|vlow)$/i, '').toLocaleLowerCase();
}

function isHighLodYft(path: string) {
  return /_hi\.yft$/i.test(path);
}

async function getVehicleIdentifiers(files: ResourcePackageFile[]) {
  const modelNames = new Set<string>();
  const gameNames = new Set<string>();
  for (const item of files) {
    if (!item.path.toLowerCase().endsWith('vehicles.meta') || item.file.size > 8 * 1024 * 1024) continue;
    const text = await item.file.text();
    for (const match of text.matchAll(/<modelName(?:\s[^>]*)?\s*>([^<]+)<\/modelName\s*>/gi)) {
      const value = match[1].trim();
      if (value) modelNames.add(value.toLocaleLowerCase());
    }
    for (const match of text.matchAll(/<gameName(?:\s[^>]*)?\s*>([^<]+)<\/gameName\s*>/gi)) {
      const value = match[1].trim();
      if (value) gameNames.add(value.toLocaleLowerCase());
    }
  }
  return { modelNames: [...modelNames], gameNames: [...gameNames] };
}

function chooseMainYft(yfts: ResourcePackageFile[], identifiers: string[]) {
  if (!yfts.length) return null;
  const matching = yfts.filter((item) => identifiers.includes(normalizeYftStem(item.path)));
  if (matching.length) {
    const base = matching.find((item) => !isHighLodYft(item.path)) || matching[0];
    return matching.find((item) => isHighLodYft(item.path) && normalizeYftStem(item.path) === normalizeYftStem(base.path)) || base;
  }
  const ranked = [...yfts].sort((a, b) => {
    if (isHighLodYft(a.path) !== isHighLodYft(b.path)) return isHighLodYft(a.path) ? 1 : -1;
    return b.file.size - a.file.size;
  });
  const base = ranked.find((item) => !isHighLodYft(item.path)) || ranked[0];
  return yfts.find((item) => isHighLodYft(item.path) && normalizeYftStem(item.path) === normalizeYftStem(base.path)) || base;
}

function describeVehiclePart(path: string, identifiers: string[]) {
  let label = (path.split('/').pop() || path).replace(/\.yft$/i, '').replace(/_(?:hi|med|low|vlow)$/i, '');
  for (const identifier of identifiers.filter(Boolean).sort((a, b) => b.length - a.length)) {
    label = label.replace(new RegExp(`^${identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[_ .-]*`, 'i'), '');
  }
  label = label.replace(/^ff[_ .-]*/i, 'FF ');
  label = label.replace(/bumr/ig, 'bumper').replace(/grill/ig, 'grille');
  label = label.replace(/([a-z])(\d)/ig, '$1 $2').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!label) label = 'Tuning part';
  if (/^ff\b/i.test(label)) return `FF ${label.slice(2).trim().replace(/\b\w/g, (letter) => letter.toUpperCase())}`;
  return label.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function inlineVehicleParts(name: string): InlineVehiclePart[] {
  const parts = new Map<string, InlineVehiclePart>();
  const indexWords: Record<string, string> = {
    zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7',
    eight: '8', nine: '9', ten: '10', eleven: '11', twelve: '12', thirteen: '13', fourteen: '14',
    fifteen: '15', sixteen: '16', seventeen: '17', eighteen: '18', nineteen: '19', twenty: '20',
  };
  const addExtra = (value: string, rawVariant = '') => {
    const variant = ({ flip: 'flipped', flipped: 'flipped', reverse: 'reversed', reversed: 'reversed', mirror: 'mirrored', mirrored: 'mirrored' } as Record<string, string>)[rawVariant.toLowerCase()] || '';
    const rawValue = value.toLowerCase();
    const normalizedValue = indexWords[rawValue] || rawValue;
    const labelValue = normalizedValue.replace(/([a-z])(\d)/g, '$1 $2').replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
    const id = `extra:${normalizedValue}:${variant || 'normal'}`;
    parts.set(id, { id, label: `Extra ${labelValue}${variant ? ` · ${variant[0].toUpperCase()}${variant.slice(1)}` : ''}`, category: 'extra' });
  };
  const prefixVariant = /(?<![a-z0-9])(flipped|flip|reversed|reverse|mirrored|mirror)[_.\s·-]*extra[_.\s·-]*([a-z0-9]+)(?![a-z0-9])/gi;
  const suffixVariant = /(?<![a-z0-9])extra[_.\s·-]*([a-z0-9]+)(?:[_.\s·-]*(flipped|flip|reversed|reverse|mirrored|mirror))?(?![a-z0-9])/gi;
  const middleVariant = /(?<![a-z0-9])extra[_.\s·-]*(flipped|flip|reversed|reverse|mirrored|mirror)[_.\s·-]*([a-z0-9]+)(?![a-z0-9])/gi;
  const variantWords = new Set(['flipped', 'flip', 'reversed', 'reverse', 'mirrored', 'mirror']);
  for (const match of name.matchAll(prefixVariant)) addExtra(match[2], match[1]);
  for (const match of name.matchAll(middleVariant)) addExtra(match[2], match[1]);
  for (const match of name.matchAll(suffixVariant)) {
    if (!variantWords.has(match[1].toLowerCase())) addExtra(match[1], match[2] || '');
  }

  const inlinePattern = /(?:^|[_ .-])(modkit|mod|tuning)[_ .:-]*([a-z0-9]+)/i;
  const match = name.match(inlinePattern);
  if (match) {
    const prefix = match[1].toLowerCase();
    const value = match[2].toLowerCase();
    const category = prefix === 'tuning' || prefix === 'modkit' ? 'Tuning' : 'Mod';
    const labelValue = value.replace(/([a-z])(\d)/g, '$1 $2').replace(/[_-]+/g, ' ');
    const id = `${prefix}:${value}`;
    parts.set(id, { id, label: `${category} ${labelValue.replace(/\b\w/g, (letter) => letter.toUpperCase())}`, category: 'inline' });
  }
  return [...parts.values()];
}

function vehiclePartsForNode(node: THREE.Object3D): InlineVehiclePart[] {
  const parts = new Map<string, InlineVehiclePart>();
  let current: THREE.Object3D | null = node;
  while (current) {
    inlineVehicleParts(current.name).forEach((part) => parts.set(part.id, part));
    current = current.parent;
  }
  return [...parts.values()];
}

function gtaMaterialMetadata(name: string) {
  const marker = ' ||GTA||';
  const markerIndex = name.lastIndexOf(marker);
  if (markerIndex < 0) return null;
  try {
    const metadata = JSON.parse(decodeURIComponent(name.slice(markerIndex + marker.length))) as {
      shader?: string;
      textures?: Record<string, string>;
      baseColor?: number[];
    };
    return { ...metadata, materialName: name.slice(0, markerIndex).split(' · ')[0] };
  } catch {
    return null;
  }
}

function meshStats(root: THREE.Object3D | null) {
  let meshes = 0, triangles = 0, materials = 0;
  const seen = new Set<THREE.Material>();
  if (root) root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    meshes++;
    const geometry = mesh.geometry;
    triangles += geometry.index ? geometry.index.count / 3 : (geometry.attributes.position?.count || 0) / 3;
    (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach((mat) => seen.add(mat));
  });
  materials = seen.size;
  if (root) root.updateMatrixWorld(true);
  const box = root ? new THREE.Box3().setFromObject(root) : new THREE.Box3();
  const size = box.isEmpty() ? new THREE.Vector3() : box.getSize(new THREE.Vector3());
  return { meshes, triangles: Math.floor(triangles), materials, size };
}
function fmt(value: number) { return value >= 1000 ? value.toLocaleString(undefined, { maximumFractionDigits: 0 }) : value.toFixed(2); }
function meshFrom(object: THREE.Object3D | null): THREE.Mesh | null {
  if (!object) return null;
  if ((object as THREE.Mesh).isMesh) return object as THREE.Mesh;
  let first: THREE.Mesh | null = null;
  object.traverse((item) => { if (!first && (item as THREE.Mesh).isMesh) first = item as THREE.Mesh; });
  return first;
}
function cloneScene(source: THREE.Group) {
  source.traverse((object) => {
    object.userData.forgeHistoryId ||= object.uuid;
  });
  const copy = source.clone(true) as THREE.Group;
  copy.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const cloneMaterial = (material: THREE.Material) => {
      const cloned = material.clone() as THREE.MeshStandardMaterial;
      if (cloned.map) cloned.map = cloned.map.clone();
      return cloned;
    };
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(cloneMaterial) : cloneMaterial(mesh.material);
  });
  return copy;
}
function IconButton({ icon: Icon, label, onClick, active = false, disabled = false }: { icon: typeof Box; label: string; onClick?: () => void; active?: boolean; disabled?: boolean }) {
  return <button type="button" className={`icon-button${active ? ' is-active' : ''}`} aria-label={label} title={label} disabled={disabled} onClick={onClick} data-testid={`button-${label.toLowerCase().replaceAll(' ', '-')}`}><Icon size={15} strokeWidth={1.8} /></button>;
}

function App() {
  const picker = useRef<HTMLInputElement>(null);
  const texturePicker = useRef<HTMLInputElement>(null);
  const resourcePicker = useRef<HTMLInputElement>(null);
  const resourceFolderPicker = useRef<HTMLInputElement>(null);
  const [root, setRoot] = useState<THREE.Group | null>(null);
  const [sceneRevision, setSceneRevision] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [projectName, setProjectName] = useState('Untitled project');
  const [projectId, setProjectId] = useState<string>(crypto.randomUUID());
  const [hasSavedProject, setHasSavedProject] = useState(false);
  const [format, setFormat] = useState('—');
  const [sourceFiles, setSourceFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState<Busy>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [dragging, setDragging] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [grid, setGrid] = useState(true);
  const [axes, setAxes] = useState(true);
  const [wireframe, setWireframe] = useState(false);
  const [ortho, setOrtho] = useState(false);
  const [transformMode, setTransformMode] = useState<'translate' | 'rotate' | 'scale'>('translate');
  const [background, setBackground] = useState('#202124');
  const [showTree, setShowTree] = useState(() => window.innerWidth >= 768);
  const [searchOpen, setSearchOpen] = useState(false);
  const [sceneQuery, setSceneQuery] = useState('');
  const [showInspector, setShowInspector] = useState(() => window.innerWidth >= 768);
  const [panelTab, setPanelTab] = useState<'object' | 'material'>('object');
  const [exportOpen, setExportOpen] = useState(false);
  const [projectOpen, setProjectOpen] = useState(false);
  const [resourceOpen, setResourceOpen] = useState(false);
  const [textureStudioOpen, setTextureStudioOpen] = useState(false);
  const [resourcePackage, setResourcePackage] = useState<ResourcePackage | null>(null);
  const [vehicleAddonParts, setVehicleAddonParts] = useState<VehicleAddonPart[]>([]);
  const [vehicleNativeExtras, setVehicleNativeExtras] = useState<VehicleExtraSource[]>([]);
  const [vehicleInlinePartEnabled, setVehicleInlinePartEnabled] = useState<Record<string, boolean>>({});
  const [vehicleSpawnModelNames, setVehicleSpawnModelNames] = useState<string[]>([]);
  const [projects, setProjects] = useState<LocalProject[]>([]);
  const [exportName, setExportName] = useState('vehicle_asset');
  const [textureShown, setTextureShown] = useState(true);
  const [nextImportMode, setNextImportMode] = useState<'append' | 'replace'>('append');
  const vehicleTextureFiles = useRef<File[]>([]);

  useEffect(() => {
    const mobile = window.matchMedia('(max-width: 767px)');
    const syncPanels = (event: MediaQueryListEvent) => {
      setShowTree(!event.matches);
      setShowInspector(!event.matches);
    };
    mobile.addEventListener('change', syncPanels);
    return () => mobile.removeEventListener('change', syncPanels);
  }, []);
  useEffect(() => {
    resourceFolderPicker.current?.setAttribute('webkitdirectory', '');
    resourceFolderPicker.current?.setAttribute('directory', '');
  }, []);
  const history = useRef<THREE.Group[]>([]);
  const future = useRef<THREE.Group[]>([]);
  const hiddenTextures = useRef(new Map<string, THREE.Texture>());
  const selected = useMemo(() => {
    if (!root || !selectedId) return root;
    let found: THREE.Object3D | null = null;
    root.traverse((item) => { if (item.uuid === selectedId || item.userData.forgeHistoryId === selectedId) found = item; });
    return found || root;
  }, [root, selectedId]);
  const stats = useMemo(() => meshStats(root), [root, sourceFiles.length, sceneRevision]);
  const inlineParts = useMemo(() => {
    if (!root) return [];
    const groups = new Map<string, { label: string; category: 'extra' | 'inline'; nodes: THREE.Object3D[]; sources?: string[] }>();
    root.traverse((node) => {
      if (!(node as THREE.Mesh).isMesh) return;
      const mesh = node as THREE.Mesh;
      const parts = Array.isArray(mesh.userData.forgeVehicleParts)
        ? mesh.userData.forgeVehicleParts as InlineVehiclePart[]
        : vehiclePartsForNode(mesh);
      mesh.userData.forgeVehicleParts = parts;
      parts.forEach((part) => {
        const group = groups.get(part.id) || { label: part.label, category: part.category, nodes: [] };
        group.nodes.push(mesh);
        groups.set(part.id, group);
      });
    });
    vehicleNativeExtras.forEach((extra) => {
      const group = groups.get(extra.id);
      if (group) group.sources = extra.sources;
      else groups.set(extra.id, { label: extra.label, category: 'extra', nodes: [], sources: extra.sources });
    });
    return [...groups.entries()]
      .map(([id, group]) => ({
        id,
        label: group.label,
        category: group.category,
        enabled: vehicleInlinePartEnabled[id] ?? (group.category === 'extra' ? false : group.nodes.some((node) => node.visible)),
        disabled: group.nodes.length === 0,
        source: group.nodes.length === 0 && group.sources?.length ? `Found in ${group.sources.join(', ')}; not in the current preview` : undefined,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [root, sceneRevision, vehicleNativeExtras, vehicleInlinePartEnabled]);
  const activeMesh = meshFrom(selected);
  const material = activeMesh ? (Array.isArray(activeMesh.material) ? activeMesh.material[0] : activeMesh.material) : null;
  const standard = material as THREE.MeshStandardMaterial | null;
  const gtaMaterial = material ? gtaMaterialMetadata(material.name || '') : null;
  const supportsPbr = !!material && 'roughness' in material && 'metalness' in material;
  const textureRef = useRef<THREE.Texture | null>(null);
  const baseTexture = standard?.map || textureRef.current;
  const displayedAddonParts = vehicleAddonParts.map((part) => {
    const group = root?.children.find((child) => child.userData.forgeVehiclePartId === part.id);
    return { ...part, category: 'addon' as const, enabled: group ? group.visible : Boolean(part.loading && part.enabled) };
  });

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (dirty || resourcePackage) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty, resourcePackage]);
  useEffect(() => {
    if (!exportOpen && !projectOpen) return;
    const dismiss = (event: KeyboardEvent) => { if (event.key === 'Escape') { setExportOpen(false); setProjectOpen(false); } };
    window.addEventListener('keydown', dismiss);
    return () => window.removeEventListener('keydown', dismiss);
  }, [exportOpen, projectOpen]);

  const snapshot = useCallback(() => {
    if (!root) return;
    history.current = [...history.current.slice(-24), cloneScene(root)];
    future.current = [];
  }, [root]);
  const makeExportCopy = () => {
    if (!root) throw new Error('No scene to export.');
    const copy = cloneScene(root);
    let clonedSelection: THREE.Object3D | null = null;
    const historyId = selected?.userData.forgeHistoryId || selected?.uuid;
    copy.traverse((item) => {
      if (item.userData.forgeHistoryId === historyId) clonedSelection = item;
      delete item.userData.forgeHistoryId;
    });
    if (!textureShown && textureRef.current && clonedSelection) {
      const mesh = meshFrom(clonedSelection);
      if (mesh) {
        const mat = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial;
        mat.map = textureRef.current.clone();
      }
    }
    const sourceMeshes: THREE.Mesh[] = [];
    const clonedMeshes: THREE.Mesh[] = [];
    root.traverse((object) => { if ((object as THREE.Mesh).isMesh) sourceMeshes.push(object as THREE.Mesh); });
    copy.traverse((object) => { if ((object as THREE.Mesh).isMesh) clonedMeshes.push(object as THREE.Mesh); });
    sourceMeshes.forEach((source, index) => {
      const target = clonedMeshes[index];
      if (!target) return;
      const sourceMats = Array.isArray(source.material) ? source.material : [source.material];
      const targetMats = Array.isArray(target.material) ? target.material : [target.material];
      sourceMats.forEach((sourceMat, matIndex) => {
        const hidden = hiddenTextures.current.get(sourceMat.uuid);
        if (hidden && targetMats[matIndex]) (targetMats[matIndex] as THREE.MeshStandardMaterial).map = hidden.clone();
      });
    });
    return copy;
  };
  const walkFiles = async (files: File[], mode: 'append' | 'replace' = 'append', originalFiles = files, preserveResource = false): Promise<boolean> => {
    let progressTimer = 0;
    try {
      const hasZip = files.some((file) => file.name.toLowerCase().endsWith('.zip'));
      if (hasZip) setBusy({ label: 'Opening ZIP package', progress: 4 });
      const importFiles = await expandArchives(files, (completed, total, archiveName) => {
        setBusy({ label: `Unpacking ${archiveName} (${completed}/${total})`, progress: Math.min(30, 5 + Math.round((completed / total) * 25)) });
      });
      const modelFile = validateFiles(importFiles);
      setBusy({ label: `Reading ${modelFile.name}`, progress: 8 });
      progressTimer = window.setInterval(() => setBusy((v) => v ? { ...v, progress: Math.min(v.progress + 13, 86) } : v), 120);
      const modelFiles = importFiles.filter((file) => ['glb', 'gltf', 'obj', 'stl'].includes(file.name.split('.').pop()?.toLowerCase() || ''));
      const loadedAssets = await Promise.all(modelFiles.map((file) => loadAsset([file, ...importFiles.filter((sidecar) => sidecar !== file)])));
      window.clearInterval(progressTimer);
      setBusy({ label: 'Preparing scene', progress: 92 });
       const nextPartStates: Record<string, boolean> = mode === 'replace' || !root ? {} : { ...vehicleInlinePartEnabled };
       loadedAssets.forEach(({ root: assetRoot }) => {
         assetRoot.traverse((node) => {
           const mesh = node as THREE.Mesh;
           if (!mesh.isMesh) return;
           const parts = vehiclePartsForNode(mesh);
           mesh.userData.forgeVehicleParts = parts;
           parts.forEach((part) => {
             if (nextPartStates[part.id] === undefined) nextPartStates[part.id] = part.category === 'extra' ? false : mesh.visible;
           });
           const extras = parts.filter((part) => part.category === 'extra');
           if (extras.length) mesh.visible = extras.some((part) => nextPartStates[part.id]);
           else if (parts.length) mesh.visible = parts.some((part) => nextPartStates[part.id]);
         });
       });
      const scene = mode === 'replace' || !root ? new THREE.Group() : root;
      if (mode === 'replace' || !root) { scene.clear(); hiddenTextures.current.clear(); }
      loadedAssets.forEach((loaded) => scene.add(loaded.root));
       setVehicleInlinePartEnabled(nextPartStates);
      const firstAsset = loadedAssets[0];
      scene.name = mode === 'replace' || !root ? firstAsset.name : scene.name;
      if (mode === 'replace' && !preserveResource) {
        setResourcePackage(null);
        setResourceOpen(false);
        setVehicleAddonParts([]);
         setVehicleNativeExtras([]);
         setVehicleSpawnModelNames([]);
        vehicleTextureFiles.current = [];
      }
      setRoot(scene); setSceneRevision((v) => v + 1); setSelection(meshFrom(firstAsset.root) || firstAsset.root); setFormat(loadedAssets.map((item) => item.format).join(' + '));
       setSourceFiles((existing) => mode === 'replace' ? originalFiles : [...existing, ...originalFiles]);
      setProjectName(mode === 'replace' || !root ? firstAsset.name : projectName);
      setDirty(true); history.current = []; future.current = [];
      const importedMeshes = loadedAssets.reduce((count, item) => count + meshStats(item.root).meshes, 0);
      setNotice({ kind: 'success', message: `${loadedAssets.length} asset${loadedAssets.length === 1 ? '' : 's'} loaded · ${importedMeshes} mesh${importedMeshes === 1 ? '' : 'es'}` });
      window.setTimeout(() => setBusy(null), 260);
      return true;
    } catch (error) {
      window.clearInterval(progressTimer);
      setBusy(null);
      if (files.some((file) => file.name.toLowerCase().endsWith('.zip'))) {
        try {
          const resource = await readResourcePackage(files);
          setResourcePackage(resource);
          setResourceOpen(true);
          const nativeCount = resource.files.filter((file) => file.kind === 'native').length;
          setNotice({ kind: 'success', message: `${resource.name} imported · ${resource.files.length} resource files${nativeCount ? ` · ${nativeCount} native GTA assets preserved` : ''}` });
          return true;
        } catch {
          // Keep the model import error when this ZIP is not a FiveM resource.
        }
      }
      setNotice({ kind: 'error', message: error instanceof Error ? error.message : 'Could not read this file.' });
      return false;
    }
  };
  const loadPicked = (files: FileList | null, mode: 'append' | 'replace') => {
    if (!files?.length) return;
    const list = Array.from(files);
    if (list.some((file) => !file.name.toLowerCase().endsWith('.zip') && file.size > MAX_FILE_SIZE)) { setNotice({ kind: 'error', message: 'Files must be smaller than 250 MB.' }); return; }
    if (list.some((file) => file.name.toLowerCase().endsWith('.zip'))) {
      void (async () => {
        const isResource = await importResource(list);
        if (!isResource) await walkFiles(list, mode);
      })();
      return;
    }
    const nativeExtensions = ['yft', 'ytd', 'ydr', 'ydd', 'ybn', 'ytyp', 'ymap', 'ymf', 'ycd', 'ymt', 'yld', 'ypt', 'meta'];
    const pickedExtensions = list.map((file) => file.name.split('.').pop()?.toLowerCase() || '');
    const hasResourceManifest = list.some((file) => ['fxmanifest.lua', '__resource.lua'].includes(file.name.split('/').pop()?.toLowerCase() || ''));
    const yftFiles = list.filter((file) => file.name.toLowerCase().endsWith('.yft'));
    const yftCompanions = new Set(['yft', 'ytd', 'glb', 'gltf', 'obj', 'stl', 'mtl', 'bin', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp']);
    if (!list.some((file) => file.name.toLowerCase().endsWith('.zip')) &&
        yftFiles.length === 1 &&
        !hasResourceManifest &&
        pickedExtensions.every((ext) => yftCompanions.has(ext))) {
      void loadYftIntoScene(list, yftFiles[0], mode);
      return;
    }
    if (!list.some((file) => file.name.toLowerCase().endsWith('.zip')) &&
        (pickedExtensions.some((ext) => nativeExtensions.includes(ext)) || hasResourceManifest) &&
        !pickedExtensions.some((ext) => ['glb', 'gltf', 'obj', 'stl'].includes(ext))) {
      void importResource(files);
      return;
    }
    void walkFiles(list, mode);
  };
  const loadYftIntoScene = async (files: File[], modelFile: File, mode: 'append' | 'replace', packageOverride?: ResourcePackage) => {
    setBusy({ label: `Converting ${modelFile.name} for the viewport`, progress: 12 });
    try {
      const resource = packageOverride || await readResourcePackage(files);
      setResourcePackage(resource);
      setResourceOpen(false);
      const ytdFiles = resource.files.filter((item) => item.path.toLowerCase().endsWith('.ytd'));
      const yftFiles = resource.files.filter((item) => item.path.toLowerCase().endsWith('.yft'));
      const vehicleIdentifiers = await getVehicleIdentifiers(resource.files);
      const knownIdentifiers = [...new Set([...vehicleIdentifiers.modelNames, ...vehicleIdentifiers.gameNames])];
      const modelStem = normalizeYftStem(modelFile.name);
      const modelEntry = yftFiles.find((item) => item.file === modelFile) ||
        yftFiles.find((item) => (item.path.split('/').pop() || '').toLowerCase() === modelFile.name.toLowerCase());
      const modelPair = yftFiles
        .filter((item) => normalizeYftStem(item.path) === modelStem)
        .sort((a, b) => Number(isHighLodYft(a.path)) - Number(isHighLodYft(b.path)));
      const modelCandidates = [...new Map([modelEntry, ...modelPair].filter((item): item is ResourcePackageFile => Boolean(item)).map((item) => [item.path.toLowerCase(), item])).values()];
      if (!modelCandidates.length) modelCandidates.push({ path: modelFile.name, file: modelFile, kind: 'native' });

       const inspectedCandidates = await Promise.all(modelCandidates.map(async (candidate) => {
         try {
           return { candidate, extras: await inspectNativeYftExtras(candidate.file), error: undefined };
         } catch (error) {
           return { candidate, extras: [] as NativeYftExtra[], error: error instanceof Error ? error.message : 'Could not inspect this YFT.' };
         }
       }));
       const inspectionErrors = inspectedCandidates.filter((item) => item.error).map((item) => `${item.candidate.path}: ${item.error}`);
       const extrasById = new Map<string, { extra: NativeYftExtra; sources: Set<string> }>();
       inspectedCandidates.forEach(({ candidate, extras }) => extras.forEach((extra) => {
         const entry = extrasById.get(extra.id) || { extra, sources: new Set<string>() };
         entry.sources.add(candidate.path.split('/').pop() || candidate.path);
         extrasById.set(extra.id, entry);
       }));
       const previewCandidates = [...inspectedCandidates].sort((a, b) =>
         b.extras.length - a.extras.length ||
         Number(isHighLodYft(b.candidate.path)) - Number(isHighLodYft(a.candidate.path)) ||
         b.candidate.file.size - a.candidate.file.size,
       );
      let preview: Awaited<ReturnType<typeof previewNativeYft>> | null = null;
      let selectedModel = modelFile;
      let selectedYtds: File[] = [];
      let lastPreviewError: unknown;
       for (const { candidate } of previewCandidates) {
        const stem = normalizeYftStem(candidate.path);
        const prioritizedYtds = [
          ...ytdFiles.filter((item) => normalizeYftStem(item.path.replace(/\.ytd$/i, '.yft')) === stem),
          ...ytdFiles.filter((item) => normalizeYftStem(item.path.replace(/\.ytd$/i, '.yft')) !== stem),
        ];
        const candidateYtds: File[] = [];
        let previewBytes = candidate.file.size;
        for (const item of prioritizedYtds) {
          if (candidateYtds.length >= 24 || previewBytes + item.file.size > MAX_FILE_SIZE) continue;
          candidateYtds.push(item.file);
          previewBytes += item.file.size;
        }
        try {
          preview = await previewNativeYft(candidate.file, candidateYtds);
          selectedModel = candidate.file;
          selectedYtds = candidateYtds;
          break;
        } catch (error) {
          lastPreviewError = error;
        }
      }
      if (!preview) throw lastPreviewError instanceof Error ? lastPreviewError : new Error('No compatible YFT LOD could be previewed.');
       preview.extras.forEach((extra) => {
         const entry = extrasById.get(extra.id) || { extra, sources: new Set<string>() };
         entry.sources.add(selectedModel.name);
         extrasById.set(extra.id, entry);
       });
       const availableExtraIds = new Set(preview.meshExtras);
       const allNativeExtras: VehicleExtraSource[] = [...extrasById.values()]
         .map(({ extra, sources }) => ({ ...extra, sources: [...sources] }))
         .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));

      vehicleTextureFiles.current = selectedYtds;
      const addonFiles = yftFiles.filter((item) => {
        const stem = normalizeYftStem(item.path);
        return stem !== modelStem && !knownIdentifiers.includes(stem);
      });
      const nextAddonParts: VehicleAddonPart[] = addonFiles.map((item) => ({
        id: item.path.toLocaleLowerCase(),
        label: describeVehiclePart(item.path, knownIdentifiers),
        enabled: false,
        source: item.path,
        file: item.file,
      }));

      const otherModels = resource.files
        .filter((item) => ['glb', 'gltf', 'obj', 'stl'].includes(item.path.split('.').pop()?.toLowerCase() || ''))
        .map((item) => item.file);
      const originalFiles = resource.files.map((item) => item.file);
      const importedCompanions = files.filter((file) => ![modelFile, ...ytdFiles.map((item) => item.file), ...otherModels].includes(file));
      const loaded = await walkFiles([preview.model, ...otherModels, ...importedCompanions], mode, originalFiles, true);
      if (!loaded) return;
      setVehicleAddonParts(nextAddonParts);
       setVehicleNativeExtras(allNativeExtras);
       const selectedStem = normalizeYftStem(selectedModel.name);
       setVehicleSpawnModelNames([
         vehicleIdentifiers.modelNames.find((name) => name.toLowerCase() === selectedStem) ||
         vehicleIdentifiers.modelNames[0] ||
         selectedStem,
       ]);
      const modelLabel = vehicleIdentifiers.modelNames.find((name) => name === normalizeYftStem(selectedModel.name)) || selectedModel.name.replace(/\.yft$/i, '');
      if (mode === 'replace') setProjectName(modelLabel);
      setFormat(`${selectedModel.name} · YFT preview`);
      const textureStatus = preview.textureCount
        ? `${preview.textureCount} YTD texture${preview.textureCount === 1 ? '' : 's'} matched`
        : selectedYtds.length
          ? 'no YTD textures matched the model material references'
          : 'no matching YTD was available for preview';
      const skippedMeshes = preview.skippedMeshCount
        ? ` ${preview.skippedMeshCount} mesh entries without usable triangles were skipped.`
        : '';
      const unmatched = preview.unmatchedTextures.length
        ? ` Unmatched texture names: ${preview.unmatchedTextures.slice(0, 3).join(', ')}${preview.unmatchedTextures.length > 3 ? '…' : ''}.`
        : '';
      const omitted = selectedYtds.length < ytdFiles.length ? ' Some YTDs were skipped to stay within preview limits.' : '';
      const textureErrors = preview.textureErrors.length ? ` ${preview.textureErrors.length} unreadable YTD${preview.textureErrors.length === 1 ? ' was' : 's were'} skipped; the car model still loaded.` : '';
      const shaderSummary = preview.gtaShaders.length ? ` GTA shaders: ${preview.gtaShaders.slice(0, 3).join(', ')}${preview.gtaShaders.length > 3 ? '…' : ''}.` : '';
       const unpreviewedExtras = allNativeExtras.filter((extra) => !availableExtraIds.has(extra.id)).length;
       const extraSummary = ` ${allNativeExtras.length} extra${allNativeExtras.length === 1 ? '' : 's'} checked across ${modelCandidates.length} matching YFT file${modelCandidates.length === 1 ? '' : 's'}; extras start hidden in the preview.${unpreviewedExtras ? ` ${unpreviewedExtras} listed extra${unpreviewedExtras === 1 ? ' has' : 's have'} no geometry in the selected LOD.` : ''}`;
       const inspectionSummary = inspectionErrors.length
         ? ` Extra scanning was incomplete: ${inspectionErrors.slice(0, 2).join('; ')}${inspectionErrors.length > 2 ? '…' : ''}.`
         : '';
      setNotice({
         kind: preview.textureCount && !inspectionErrors.length ? 'success' : 'info',
         message: `Loaded ${preview.meshCount} usable YFT meshes; ${textureStatus}.${extraSummary}${skippedMeshes}${unmatched}${omitted}${textureErrors}${shaderSummary}${inspectionSummary} Export a source-preserving resource ZIP for the original YFT and YTD files. Viewport geometry edits export as GLB, not native YFT.`,
      });
    } catch (error) {
      setBusy(null);
      setNotice({ kind: 'error', message: error instanceof Error ? error.message : 'Could not convert this YFT for the viewport.' });
    }
  };
  const undo = () => { const prev = history.current.pop(); if (!prev || !root) return; future.current.push(cloneScene(root)); setRoot(prev); setSelectedId(prev.userData.forgeHistoryId || prev.uuid); setDirty(true); };
  const redo = () => { const next = future.current.pop(); if (!next || !root) return; history.current.push(cloneScene(root)); setRoot(next); setSelectedId(next.userData.forgeHistoryId || next.uuid); setDirty(true); };
  const setTransform = (part: 'position' | 'rotation' | 'scale', axis: 'x' | 'y' | 'z', value: number) => {
    if (!selected) return;
    if (selected.userData.forgeLocked) { setNotice({ kind: 'info', message: 'Unlock this object in the scene tree before editing it.' }); return; }
    snapshot();
    selected[part][axis] = part === 'rotation' ? THREE.MathUtils.degToRad(value) : value;
    selected.updateMatrix(); selected.updateMatrixWorld(true); setSceneRevision((v) => v + 1); setDirty(true);
  };
  const renameObject = (object: THREE.Object3D) => {
    const name = window.prompt('Object name', object.name || 'Object');
    if (name?.trim()) { snapshot(); object.name = name.trim(); setSceneRevision((v) => v + 1); setDirty(true); }
  };
  const duplicateObject = (object: THREE.Object3D) => {
    if (!root || object === root) { setNotice({ kind: 'info', message: 'Select a mesh or group inside the scene to duplicate.' }); return; }
    snapshot();
    const clone = object.clone(true); clone.name = `${object.name || 'Object'} copy`; clone.position.x += 0.15;
    object.parent?.add(clone); setSelectedId(clone.uuid); setSceneRevision((v) => v + 1); setDirty(true);
  };
  const deleteObject = (object: THREE.Object3D) => {
    if (!root || object === root) { setNotice({ kind: 'info', message: 'The scene root cannot be removed.' }); return; }
    if (!window.confirm(`Delete “${object.name || 'Object'}” from this scene?`)) return;
    snapshot(); const parent = object.parent; parent?.remove(object); setSelectedId(parent?.uuid || root.uuid); setSceneRevision((v) => v + 1); setDirty(true);
  };
  const setTexture = async (file?: File) => {
    if (!file || !activeMesh || !standard) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) { setNotice({ kind: 'error', message: 'Choose a PNG, JPEG or WebP image.' }); return; }
    const data = await file.arrayBuffer();
    const blobUrl = URL.createObjectURL(new Blob([data], { type: file.type }));
    const image = new Image();
    image.onload = () => {
      snapshot();
      const texture = new THREE.Texture(image);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.needsUpdate = true;
      textureRef.current = texture;
      hiddenTextures.current.delete(standard.uuid);
      standard.map?.dispose(); standard.map = texture; standard.needsUpdate = true;
      setTextureShown(true); setSceneRevision((v) => v + 1); setDirty(true);
      setNotice({ kind: 'success', message: `${file.name} assigned as a base-color texture.` });
      URL.revokeObjectURL(blobUrl);
    };
    image.onerror = () => { URL.revokeObjectURL(blobUrl); setNotice({ kind: 'error', message: 'This image could not be decoded.' }); };
    image.src = blobUrl;
  };
  const updateMaterial = (key: 'color' | 'roughness' | 'metalness', value: string | number) => {
    if (!standard) return;
    if (selected?.userData.forgeLocked) { setNotice({ kind: 'info', message: 'Unlock this object in the scene tree before editing it.' }); return; }
    snapshot();
    if (key === 'color') standard.color.set(value as string);
    else standard[key] = Number(value);
    standard.needsUpdate = true; setSceneRevision((v) => v + 1); setDirty(true);
  };
  const saveLocal = async (asNew = false) => {
    if (!root) { setNotice({ kind: 'info', message: 'Load a model before saving a project.' }); return; }
    const nextName = asNew ? window.prompt('Save project as', projectName) : projectName;
    if (!nextName?.trim()) return;
    try {
      setBusy({ label: 'Saving to this browser', progress: 35 });
      const blob = await exportModel(makeExportCopy(), 'glb');
      const sources = await Promise.all(sourceFiles.map(async (file) => ({ name: file.name, type: file.type, data: await file.arrayBuffer() })));
      const id = asNew ? crypto.randomUUID() : projectId;
      await saveProject({ id, name: nextName.trim(), updatedAt: Date.now(), model: blob, sources });
      setProjectId(id); setProjectName(nextName.trim()); setDirty(false); setHasSavedProject(true);
      setNotice({ kind: 'success', message: 'Project saved locally in this browser.' });
    } catch (error) { setNotice({ kind: 'error', message: error instanceof Error ? error.message : 'Local save failed.' }); }
    setBusy(null);
  };
  const openLocal = async (id: string) => {
    if (dirty && !window.confirm('Discard unsaved changes and open this local project?')) return;
    try {
      const project = await getProject(id);
      if (!project?.model) { setNotice({ kind: 'error', message: 'This local project has no saved scene.' }); return; }
      const file = new File([project.model], `${project.name}.glb`, { type: 'model/gltf-binary' });
      const opened = await walkFiles([file], 'replace');
      if (!opened) return;
      if (project.sources.length) setSourceFiles(project.sources.map((source) => new File([source.data], source.name, { type: source.type })));
      setProjectId(project.id); setProjectName(project.name); setDirty(false); setHasSavedProject(true); setProjectOpen(false);
    } catch {
      setNotice({ kind: 'error', message: 'Could not read this local project from browser storage.' });
    }
  };
  const showProjects = async () => {
    try { setProjects(await listProjects()); setProjectOpen(true); }
    catch { setNotice({ kind: 'error', message: 'Local project storage is unavailable in this browser.' }); }
  };
  const exportScene = async (kind: 'glb' | 'gltf' | 'obj' | 'stl') => {
    if (!root) return;
    const safeName = exportName.trim().replace(/[^\w.-]+/g, '_') || 'scene';
    setBusy({ label: `Building ${kind.toUpperCase()}`, progress: 24 });
    try {
      const blob = await exportModel(makeExportCopy(), kind);
      downloadBlob(blob, `${safeName}.${kind === 'gltf' || kind === 'obj' ? 'zip' : kind}`);
      setBusy(null); setExportOpen(false);
      setNotice({ kind: 'success', message: `${safeName}.${kind === 'gltf' || kind === 'obj' ? 'zip' : kind} downloaded.` });
    } catch (error) {
      setBusy(null); setNotice({ kind: 'error', message: `Export failed: ${error instanceof Error ? error.message : 'unknown error'}` });
    }
  };
  const exportTexture = () => {
    const texture = standard?.map || textureRef.current;
    if (!texture?.image) { setNotice({ kind: 'info', message: 'No base-color texture is assigned to this material.' }); return; }
    const image = texture.image as CanvasImageSource & { width: number; height: number };
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.drawImage(image, 0, 0);
    canvas.toBlob((blob) => { if (blob) downloadBlob(blob, `${activeMesh?.name || 'texture'}-basecolor.png`); });
  };
  const importResource = async (picked: FileList | File[] | null): Promise<boolean> => {
    if (!picked?.length) return false;
    const files = Array.from(picked);
    if (files.some((file) => !file.name.toLowerCase().endsWith('.zip') && file.size > MAX_FILE_SIZE)) {
      setNotice({ kind: 'error', message: 'Resource files must be smaller than 250 MB each.' });
      return false;
    }
    setBusy({ label: 'Reading FiveM resource', progress: 4 });
    try {
      const resource = await readResourcePackage(files, (completed, total, label) => {
        setBusy({ label: `Unpacking ${label} (${completed}/${total})`, progress: Math.min(88, 8 + Math.round((completed / total) * 78)) });
      });
      setResourcePackage(resource);
      setProjectName(resource.name);
      setSourceFiles(resource.files.map((item) => item.file));
      const yfts = resource.files.filter((item) => item.path.toLowerCase().endsWith('.yft'));
      if (yfts.length) {
        const identifiers = await getVehicleIdentifiers(resource.files);
        const model = chooseMainYft(yfts, [...identifiers.modelNames, ...identifiers.gameNames]) || yfts[0];
        const previewFiles = [
          model.file,
          ...resource.files.filter((item) => item.path.toLowerCase().endsWith('.ytd')).map((item) => item.file),
        ];
        await loadYftIntoScene(previewFiles, model.file, 'replace', resource);
      } else {
        vehicleTextureFiles.current = [];
        setVehicleAddonParts([]);
        setVehicleNativeExtras([]);
        setVehicleInlinePartEnabled({});
        setVehicleSpawnModelNames([]);
        setResourceOpen(true);
        const nativeCount = resource.files.filter((file) => file.kind === 'native').length;
        setNotice({
          kind: 'success',
          message: `${resource.name} imported · ${resource.files.length} files${nativeCount ? ` · ${nativeCount} native GTA assets preserved` : ''}`,
        });
      }
      return true;
    } catch (error) {
      setNotice({ kind: 'error', message: error instanceof Error ? error.message : 'Could not read this FiveM resource.' });
      return false;
    } finally {
      setBusy(null);
    }
  };
  const exportResource = async () => {
    if (!resourcePackage) return;
    const safeName = resourcePackage.name.trim().replace(/[^\w.-]+/g, '_') || 'fivem_resource';
    setBusy({ label: 'Building FiveM resource ZIP', progress: 20 });
    try {
      const extraIds = [...new Set(vehicleNativeExtras
        .map((extra) => Number(extra.id.split(':')[1]))
        .filter((id) => Number.isInteger(id) && id >= 0 && id <= 255))];
      const spawnDefaults = vehicleSpawnModelNames.length && extraIds.length
        ? { modelNames: vehicleSpawnModelNames, extraIds }
        : undefined;
      const blob = await buildFiveMResourceZip(resourcePackage, spawnDefaults);
      downloadBlob(blob, `${safeName}.zip`);
      setResourceOpen(false);
      setExportOpen(false);
      setNotice({
        kind: 'success',
        message: `${safeName}.zip downloaded as a FiveM resource package.${spawnDefaults ? ` A generated client script disables extras ${extraIds.join(', ')} by default for ${vehicleSpawnModelNames.join(', ')} vehicles.` : ''}`,
      });
    } catch (error) {
      setNotice({ kind: 'error', message: `Resource export failed: ${error instanceof Error ? error.message : 'unknown error'}` });
    } finally {
      setBusy(null);
    }
  };
  const previewNativeModel = async (file: File) => {
    const preservedSources = resourcePackage?.files.map((item) => item.file) || sourceFiles;
    const loaded = await walkFiles([file], 'replace', preservedSources.length ? preservedSources : [file], true);
    if (loaded) {
      setFormat('YFT model preview');
      setNotice({ kind: 'success', message: 'YFT preview loaded with its resource files. Export the resource ZIP to keep the original YFT and rebuilt YTD; viewport geometry edits export as GLB.' });
    }
  };
  const replaceNativeFile = (path: string, file: File) => {
    setResourcePackage((current) => current
      ? { ...current, files: current.files.map((item) => item.path === path ? { ...item, file } : item) }
      : current);
    setDirty(true);
  };
  const fitView = () => window.dispatchEvent(new CustomEvent('forge-fit-view'));
  const closeResourceDialog = useCallback(() => setResourceOpen(false), []);
  const toggleVisible = (item: THREE.Object3D) => { snapshot(); item.visible = !item.visible; setSceneRevision((v) => v + 1); setDirty(true); };
  const toggleInlineVehiclePart = (id: string) => {
    if (!root) return;
    const matches: THREE.Mesh[] = [];
    root.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh) return;
      const parts = Array.isArray(mesh.userData.forgeVehicleParts)
        ? mesh.userData.forgeVehicleParts as InlineVehiclePart[]
        : vehiclePartsForNode(mesh);
      mesh.userData.forgeVehicleParts = parts;
      if (parts.some((part) => part.id === id)) matches.push(mesh);
    });
    if (!matches.length) return;
    snapshot();
    const currentlyEnabled = vehicleInlinePartEnabled[id] ?? matches.some((node) => node.visible);
    const nextPartStates = { ...vehicleInlinePartEnabled, [id]: !currentlyEnabled };
    const isExtra = id.startsWith('extra:');
    if (isExtra) {
      root.traverse((node) => {
        const mesh = node as THREE.Mesh;
        if (!mesh.isMesh) return;
        const parts = Array.isArray(mesh.userData.forgeVehicleParts)
          ? mesh.userData.forgeVehicleParts as InlineVehiclePart[]
          : vehiclePartsForNode(mesh);
        const extraIds = parts.filter((part) => part.category === 'extra').map((part) => part.id);
        if (extraIds.length) mesh.visible = extraIds.some((partId) => nextPartStates[partId] ?? false);
      });
    } else {
      matches.forEach((node) => { node.visible = !currentlyEnabled; });
    }
    setVehicleInlinePartEnabled(nextPartStates);
    setSceneRevision((value) => value + 1);
    setDirty(true);
  };
  const toggleVehicleAddonPart = async (id: string) => {
    const part = vehicleAddonParts.find((item) => item.id === id);
    if (!part || part.loading || !root) return;
    const existing = root.children.find((child) => child.userData.forgeVehiclePartId === id);
    if (existing) {
      snapshot();
      existing.visible = !existing.visible;
      setVehicleAddonParts((current) => current.map((item) => item.id === id ? { ...item, enabled: existing.visible, error: undefined } : item));
      setSceneRevision((value) => value + 1);
      setDirty(true);
      return;
    }
    setVehicleAddonParts((current) => current.map((item) => item.id === id ? { ...item, enabled: true, loading: true, error: undefined } : item));
    try {
      const preview = await previewNativeYft(part.file, vehicleTextureFiles.current);
      const loaded = await loadAsset([preview.model]);
      loaded.root.name = part.label;
      loaded.root.userData.forgeVehiclePartId = id;
      snapshot();
      root.add(loaded.root);
      setVehicleAddonParts((current) => current.map((item) => item.id === id ? { ...item, enabled: true, loading: false, error: undefined } : item));
      setSceneRevision((value) => value + 1);
      setDirty(true);
    } catch (error) {
      setVehicleAddonParts((current) => current.map((item) => item.id === id
        ? { ...item, enabled: false, loading: false, error: error instanceof Error ? error.message : 'Could not load this part.' }
        : item));
    }
  };
  const toggleLock = (item: THREE.Object3D) => { snapshot(); item.userData.forgeLocked = !item.userData.forgeLocked; setSceneRevision((v) => v + 1); setDirty(true); };
  const setSelection = (item: THREE.Object3D) => {
    setSelectedId(item.uuid);
    const mesh = meshFrom(item);
    const selectedMat = mesh ? (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial : null;
    textureRef.current = selectedMat?.map || (selectedMat ? hiddenTextures.current.get(selectedMat.uuid) : null) || null;
    setTextureShown(Boolean(selectedMat?.map));
  };
  const clearScene = () => {
    if (dirty && !window.confirm('Discard unsaved changes and create a new project?')) return;
    setRoot(null); setSourceFiles([]); setSelectedId(null); setFormat('—'); setProjectName('Untitled project'); setHasSavedProject(false);
    setResourcePackage(null); setResourceOpen(false); setTextureStudioOpen(false); setVehicleAddonParts([]); setVehicleNativeExtras([]); setVehicleInlinePartEnabled({}); setVehicleSpawnModelNames([]); vehicleTextureFiles.current = [];
    setProjectId(crypto.randomUUID()); setDirty(false); history.current = []; future.current = []; hiddenTextures.current.clear(); textureRef.current = null; setTextureShown(true);
  };
  const openImport = (mode: 'append' | 'replace') => {
    if (mode === 'replace' && root && dirty && !window.confirm('Replace the current scene and discard unsaved changes?')) return;
    setNextImportMode(mode); picker.current?.click();
  };

  return (
    <main className="studio-shell" onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={(event) => { if (event.currentTarget === event.target) setDragging(false); }} onDrop={(event) => { event.preventDefault(); setDragging(false); loadPicked(event.dataTransfer.files, 'append'); }}>
      <input ref={picker} className="visually-hidden" type="file" multiple accept={supported} onChange={(event) => { loadPicked(event.target.files, nextImportMode); event.target.value = ''; }} />
      <input ref={texturePicker} className="visually-hidden" type="file" accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp" onChange={(event) => setTexture(event.target.files?.[0])} />
      <input ref={resourcePicker} className="visually-hidden" type="file" multiple accept=".zip,.yft,.ytd,.ydr,.ydd,.ybn,.ytyp,.ymap,.ymf,.ycd,.ymt,.yld,.ypt,.meta,.lua,.json,.cfg,.txt" onChange={(event) => { void importResource(event.target.files); event.target.value = ''; }} />
      <input ref={resourceFolderPicker} className="visually-hidden" type="file" multiple onChange={(event) => { void importResource(event.target.files); event.target.value = ''; }} />
      <header className="topbar">
        <div className="brand-lockup"><div className="forge-mark"><span /></div><div className="brand-name">FORGE <b>STUDIO</b><small>LOCAL WORKSPACE</small></div></div>
        <div className="top-divider" />
        <button className="project-title" type="button" onClick={() => { const name = window.prompt('Project name', projectName); if (name?.trim()) { setProjectName(name.trim()); setDirty(true); } }} title="Rename project">
          <span>{projectName}</span><small>{dirty || !hasSavedProject ? 'UNSAVED' : 'SAVED LOCALLY'}</small>
        </button>
        <div className="header-actions">
          <span className="local-tag"><ShieldCheck size={13} /> LOCAL ONLY</span>
          <button className="toolbar-button" onClick={() => void saveLocal()} title="Save locally" data-testid="button-save-local"><Save size={14} /><span>Save</span></button>
          <button className="toolbar-button" onClick={showProjects} title="Open local project" data-testid="button-open-project"><FolderOpen size={14} /><span>Open</span></button>
          <button className="toolbar-button resource-toolbar" onClick={() => setResourceOpen(true)} title="Import or export a FiveM resource"><FolderOpen size={14} /><span>FiveM resource</span>{resourcePackage && <b>{resourcePackage.files.length}</b>}</button>
          <button className="export-button" onClick={() => setExportOpen(true)} disabled={!root && !resourcePackage}><ArrowDownToLine size={14} /> Export</button>
        </div>
      </header>
      <nav className="menu-strip" aria-label="Workspace actions">
        <button onClick={clearScene}>New project</button>
        <button onClick={showProjects}>Open local…</button>
        <button onClick={() => void saveLocal(true)}>Save as…</button>
        <button onClick={() => setResourceOpen(true)}>FiveM resource…</button>
        <button onClick={() => openImport('replace')}>Replace scene…</button>
        <span className="menu-separator" />
        <button onClick={undo} disabled={!history.current.length} aria-label="Undo"><RotateCcw size={13} /> Undo</button>
        <button onClick={redo} disabled={!future.current.length} aria-label="Redo"><RotateCw size={13} /> Redo</button>
        <span className="menu-spacer" />
        <span className="file-safety"><HardDrive size={12} /> Files stay on this device</span>
      </nav>
      <div className={`workspace${dragging ? ' is-dragging' : ''}`}>
        {showTree && <aside className="left-rail">
          <div className="panel-heading"><div><Layers3 size={14} /><span>SCENE</span></div><IconButton icon={PanelLeftClose} label="Hide scene panel" onClick={() => setShowTree(false)} /></div>
          <div className="scene-actions"><button className="subtle-button" onClick={() => openImport('append')}><Plus size={13} /> Add asset</button><button className={`square-button${searchOpen ? ' is-active' : ''}`} title="Search scene" aria-label="Search scene" onClick={() => { setSearchOpen(!searchOpen); setSceneQuery(''); }}><Search size={14} /></button></div>
          {searchOpen && <div className="tree-search"><Search size={13} /><input autoFocus placeholder="Filter objects" value={sceneQuery} onChange={(event) => setSceneQuery(event.target.value)} /><button onClick={() => { setSearchOpen(false); setSceneQuery(''); }} aria-label="Close scene search"><X size={13} /></button></div>}
          <div className="tree-content scrollbar-thin">
            {!root ? <div className="scene-empty"><div className="empty-glyph"><Box size={18} /></div><b>Scene is empty</b><span>Import a GLB, OBJ, or YFT to edit its preview.</span><button onClick={() => openImport('append')}><Upload size={13} /> Import model</button></div> :
              <SceneTree root={root} selectedId={selectedId} query={sceneQuery} onSelect={setSelection} onRename={renameObject} onDuplicate={duplicateObject} onDelete={deleteObject} onVisible={toggleVisible} onLock={toggleLock} />}
          </div>
          <div className="native-note"><span className="native-kicker">FIVEM RESOURCE</span><p>{resourcePackage ? `${resourcePackage.name} · ${resourcePackage.files.length} files` : 'ZIP and folder packaging'}</p><div>{unsupportedGame.map((ext) => <code key={ext}>{ext}</code>)}</div><small>{resourcePackage ? 'Preview YFT models with matching YTDs and replace decoded YTD textures.' : 'Open a YFT directly, or import a ZIP/folder to replace YTD textures and package a resource.'}</small>{resourcePackage && <><button className="resource-note-button" onClick={() => setTextureStudioOpen(true)}>Open texture studio</button><button className="resource-note-button" onClick={() => setResourceOpen(true)}>Browse resource files</button></>}</div>
        </aside>}
        <section className="viewport-column">
          <div className="viewport-toolbar">
            <div className="viewport-left-tools">
              {!showTree && <IconButton icon={Menu} label="Show scene panel" onClick={() => setShowTree(true)} />}
              <span className="toolbar-caption">VIEWPORT</span><span className="view-sep" />
              <div className="transform-tools" role="group" aria-label="Transform tools">
                {([
                  ['translate', 'Move'],
                  ['rotate', 'Rotate'],
                  ['scale', 'Scale'],
                ] as const).map(([mode, label]) => (
                  <button
                    key={mode}
                    type="button"
                    className={`tool-toggle${transformMode === mode ? ' selected' : ''}`}
                    aria-pressed={transformMode === mode}
                    disabled={!root || Boolean(selected?.userData.forgeLocked)}
                    onClick={() => setTransformMode(mode)}
                  >{label}</button>
                ))}
              </div>
              <span className="view-sep" />
              <button className={`tool-toggle${grid ? ' selected' : ''}`} onClick={() => setGrid(!grid)} aria-pressed={grid}><Grid2X2 size={14} /><span>Grid</span></button>
              <button className={`tool-toggle${axes ? ' selected' : ''}`} onClick={() => setAxes(!axes)} aria-pressed={axes}><Axis3D size={14} /><span>Axes</span></button>
              <button className={`tool-toggle${wireframe ? ' selected' : ''}`} onClick={() => setWireframe(!wireframe)} aria-pressed={wireframe}><Activity size={14} /><span>Wire</span></button>
              <span className="view-sep" />
              <button className={`tool-toggle${ortho ? ' selected' : ''}`} onClick={() => setOrtho(!ortho)} aria-pressed={ortho}>{ortho ? 'ORTHO' : 'PERSP'}</button>
            </div>
            <div className="viewport-right-tools">
              <label className="background-picker" title="Viewport background"><span style={{ background: background }} /><input aria-label="Viewport background color" type="color" value={background} onChange={(e) => setBackground(e.target.value)} /></label>
              <IconButton icon={ZoomIn} label="Fit model to view" onClick={fitView} disabled={!root} />
              {!showInspector && <IconButton icon={Settings2} label="Show inspector" onClick={() => setShowInspector(true)} />}
            </div>
          </div>
          <div className="view-stage">
            <Viewport
              root={root}
              selected={root ? selected : null}
              selectedLocked={Boolean(selected?.userData.forgeLocked)}
              transformMode={transformMode}
              grid={grid}
              axes={axes}
              wireframe={wireframe}
              orthographic={ortho}
              background={background}
              onSelect={setSelection}
              onTransformStart={snapshot}
              onTransformChange={() => { setSceneRevision((value) => value + 1); setDirty(true); }}
            />
            {!root && <div className="welcome-card"><div className="welcome-symbol"><Box size={21} strokeWidth={1.5} /></div><span className="eyebrow">LOCAL 3D + FIVEM RESOURCE WORKSPACE</span><h1>Bring your model<br />into focus.</h1><p>Open GLB, GLTF, OBJ, STL, or YFT models in the regular editor. Include matching YTDs for vehicle textures.</p><div className="welcome-actions"><button className="primary-action" onClick={() => openImport('append')}><Upload size={15} /> Import a model</button><button className="secondary-action" onClick={() => setResourceOpen(true)}><FolderOpen size={15} /> FiveM resource</button></div><small>YFT edits export as standard GLB; native YFT files stay unchanged.</small></div>}
            {dragging && <div className="drag-overlay"><div className="drag-target"><Upload size={24} /><b>Drop models to add to scene</b><span>Existing objects will be kept</span></div></div>}
            {busy && <div className="busy-chip"><span className="busy-dot" /><span>{busy.label}</span><div className="progress-track"><i style={{ width: `${busy.progress}%` }} /></div><span className="mono">{busy.progress}%</span></div>}
            <div className="view-corner view-corner-top"><span className="corner-dot" /> {format === '—' ? 'NO ASSET' : `${format} · LOCAL`}</div>
            <div className="view-corner view-corner-bottom">LMB ORBIT <i /> SHIFT + LMB PAN <i /> SCROLL ZOOM</div>
          </div>
          <div className="statusbar">
            <span><span className={`status-led${root ? ' live' : ''}`} />{root ? 'SCENE READY' : 'READY'}</span>
            <span>{root ? `${stats.meshes} MESH${stats.meshes === 1 ? '' : 'ES'}` : 'NO OBJECTS'}</span>
            <span>{fmt(stats.triangles)} TRIANGLES</span>
            <span>{stats.materials} MATERIAL{stats.materials === 1 ? '' : 'S'}</span>
            {root && <span className="status-dimensions">{fmt(stats.size.x)} × {fmt(stats.size.y)} × {fmt(stats.size.z)} units</span>}
            <span className="status-spacer" /><span><ShieldCheck size={12} /> LOCAL SESSION</span>
          </div>
        </section>
        {showInspector && <aside className="right-rail">
          <div className="panel-heading"><div><Settings2 size={14} /><span>INSPECTOR</span></div><IconButton icon={PanelRightClose} label="Hide inspector" onClick={() => setShowInspector(false)} /></div>
          <div className="inspector-tabs"><button className={panelTab === 'object' ? 'active' : ''} onClick={() => setPanelTab('object')}>Object</button><button className={panelTab === 'material' ? 'active' : ''} onClick={() => setPanelTab('material')}>Material</button></div>
          {!root ? <div className="inspector-empty"><div className="empty-glyph"><Move3D size={17} /></div><b>Nothing selected</b><span>Import an asset to inspect its properties.</span></div> : panelTab === 'object' ?
            <div className="inspector-body scrollbar-thin">
              <div className="object-identity"><div className="object-icon"><Box size={16} /></div><div><strong>{selected?.name || 'Object'}</strong><small>{selected ? (selected instanceof THREE.Mesh ? 'MESH OBJECT' : selected.type.toUpperCase()) : 'SCENE'}</small></div></div>
              <TransformSection title="Position" values={selected?.position.toArray() || [0, 0, 0]} onChange={(axis, value) => setTransform('position', axis, value)} />
              <TransformSection title="Rotation" values={selected ? [THREE.MathUtils.radToDeg(selected.rotation.x), THREE.MathUtils.radToDeg(selected.rotation.y), THREE.MathUtils.radToDeg(selected.rotation.z)] : [0, 0, 0]} onChange={(axis, value) => setTransform('rotation', axis, value)} />
              <TransformSection title="Scale" values={selected?.scale.toArray() || [1, 1, 1]} onChange={(axis, value) => setTransform('scale', axis, value)} />
              <VehiclePartsPanel
                inlineParts={inlineParts}
                addonParts={displayedAddonParts}
                onToggleInline={toggleInlineVehiclePart}
                onToggleAddon={(id) => { void toggleVehicleAddonPart(id); }}
              />
              <div className="inspector-section">
                <div className="section-title">GEOMETRY</div>
                <InfoRow label="Meshes" value={String(stats.meshes)} /><InfoRow label="Triangles" value={stats.triangles.toLocaleString()} /><InfoRow label="Materials" value={String(stats.materials)} />
                <InfoRow label="Dimensions" value={`${fmt(stats.size.x)} × ${fmt(stats.size.y)} × ${fmt(stats.size.z)}`} />
              </div>
              <div className="inspector-section"><div className="section-title">OBJECT ACTIONS</div><div className="action-grid">
                <button onClick={() => selected && renameObject(selected)}><span>Aa</span> Rename</button><button onClick={() => selected && duplicateObject(selected)}><Copy size={14} /> Duplicate</button><button className="danger-action" onClick={() => selected && deleteObject(selected)}><Trash2 size={14} /> Delete</button><button onClick={() => selected && toggleVisible(selected)}>{selected?.visible ? <Eye size={14} /> : <EyeOff size={14} />} {selected?.visible ? 'Hide' : 'Show'}</button>
              </div></div>
            </div> :
            <div className="inspector-body scrollbar-thin">
              {!activeMesh || !standard || !supportsPbr ? <div className="inspector-empty"><div className="empty-glyph"><Layers3 size={17} /></div><b>{activeMesh ? 'Unsupported material' : 'No material selected'}</b><span>{activeMesh ? 'This material type is read-only. Standard PBR controls are available for MeshStandard materials.' : 'Select a mesh with a standard material.'}</span></div> : <>
                <div className="material-head"><div className="material-swatch" style={{ background: `#${standard.color.getHexString()}` }} /><div><strong>{gtaMaterial?.materialName || standard.name || 'Material'}</strong><small>{gtaMaterial?.shader ? `GTA V · ${gtaMaterial.shader}` : standard.type.toUpperCase()}</small></div></div>
                {gtaMaterial && <div className="inspector-section gta-material-section">
                  <div className="section-title">GTA V MATERIAL DATA</div>
                  {Object.entries(gtaMaterial.textures || {}).map(([slot, textureName]) => <InfoRow key={`${slot}-${textureName}`} label={slot} value={textureName} />)}
                  <p>Viewport material is a PBR approximation; GTA’s game shader is identified here but is not executed in the browser.</p>
                  <a href="https://docs.sollumz.org/2.6/documentation/fragments.yft/vehicle-shaders" target="_blank" rel="noreferrer">GTA vehicle shader and paint reference ↗</a>
                </div>}
                <div className="inspector-section"><div className="section-title">SURFACE</div><label className="color-field"><span>Base color</span><div><input type="color" value={`#${standard.color.getHexString()}`} onChange={(e) => updateMaterial('color', e.target.value)} /><code>{standard.color.getHexString().toUpperCase()}</code></div></label>
                  <RangeField label="Roughness" value={standard.roughness ?? 0.5} onChange={(v) => updateMaterial('roughness', v)} /><RangeField label="Metalness" value={standard.metalness ?? 0} onChange={(v) => updateMaterial('metalness', v)} />
                </div>
                <div className="inspector-section texture-section"><div className="section-title">BASE-COLOR TEXTURE</div>
                  {baseTexture ? <div className="texture-preview"><img src={(baseTexture.image as HTMLImageElement)?.src || ''} alt="Current base-color texture" /><div><b>{(baseTexture.image as HTMLImageElement)?.width || 'Texture'} × {(baseTexture.image as HTMLImageElement)?.height || ''}</b><small>sRGB color map</small></div></div> : <div className="texture-empty">No base-color image assigned</div>}
                  <div className="texture-actions"><button onClick={() => texturePicker.current?.click()}><ImagePlus size={13} /> {baseTexture ? 'Replace image' : 'Import image'}</button><button onClick={() => { if (baseTexture) { snapshot(); textureRef.current = null; hiddenTextures.current.delete(standard.uuid); standard.map = null; standard.needsUpdate = true; setSceneRevision((v) => v + 1); setDirty(true); } }} disabled={!baseTexture}>Revert</button><button onClick={exportTexture} disabled={!baseTexture}><Download size={13} /> Save image</button></div>
                  <label className="check-row"><input type="checkbox" checked={textureShown} disabled={!baseTexture} onChange={(e) => { setTextureShown(e.target.checked); if (standard) { if (e.target.checked) { standard.map = hiddenTextures.current.get(standard.uuid) || textureRef.current; hiddenTextures.current.delete(standard.uuid); } else if (standard.map) { hiddenTextures.current.set(standard.uuid, standard.map); textureRef.current = standard.map; standard.map = null; } standard.needsUpdate = true; setSceneRevision((v) => v + 1); setDirty(true); } }} /> Display texture on model</label>
                  {baseTexture && <><RangeField label={`Repeat U · ${baseTexture.repeat.x.toFixed(2)}`} value={Math.min(baseTexture.repeat.x / 4, 1)} onChange={(v) => { baseTexture.wrapS = THREE.RepeatWrapping; baseTexture.repeat.x = Math.max(.1, v * 4); baseTexture.needsUpdate = true; setSceneRevision((n) => n + 1); setDirty(true); }} /><RangeField label={`Repeat V · ${baseTexture.repeat.y.toFixed(2)}`} value={Math.min(baseTexture.repeat.y / 4, 1)} onChange={(v) => { baseTexture.wrapT = THREE.RepeatWrapping; baseTexture.repeat.y = Math.max(.1, v * 4); baseTexture.needsUpdate = true; setSceneRevision((n) => n + 1); setDirty(true); }} /><RangeField label={`Offset U · ${baseTexture.offset.x.toFixed(2)}`} value={(baseTexture.offset.x + 1) / 2} onChange={(v) => { baseTexture.offset.x = v * 2 - 1; baseTexture.needsUpdate = true; setSceneRevision((n) => n + 1); setDirty(true); }} /><RangeField label={`Offset V · ${baseTexture.offset.y.toFixed(2)}`} value={(baseTexture.offset.y + 1) / 2} onChange={(v) => { baseTexture.offset.y = v * 2 - 1; baseTexture.needsUpdate = true; setSceneRevision((n) => n + 1); setDirty(true); }} /></>}
                </div>
                 <div className="data-map-note"><ShieldCheck size={13} /><span>Base color and available normal maps are approximated in the viewport. Other GTA samplers are listed above; original YTD files stay preserved in the resource ZIP.</span></div>
              </>}
            </div>}
        </aside>}
      </div>
      <footer className="bottom-note"><span>FORGE STUDIO <i>·</i> BROWSER WORKSHOP</span><span>YFT preview uses a converted GLB; replaced textures are rebuilt into YTD dictionaries.</span><span>V 0.2.0</span></footer>
      {notice && <div className={`notice notice-${notice.kind}`} role="status"><span>{notice.kind === 'success' ? <Check size={14} /> : notice.kind === 'error' ? <X size={14} /> : <CircleHelp size={14} />}</span>{notice.message}<button onClick={() => setNotice(null)} aria-label="Dismiss message"><X size={13} /></button></div>}
       {exportOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) setExportOpen(false); }}><section className="dialog export-dialog" role="dialog" aria-modal="true" aria-labelledby="export-title"><div className="dialog-header"><div><span className="eyebrow">GENERATE FILE</span><h2 id="export-title">Export {root ? 'scene' : 'resource'}</h2></div><IconButton icon={X} label="Close export" onClick={() => setExportOpen(false)} /></div><p className="dialog-intro">Downloads are generated locally and saved directly to your device.</p>{resourcePackage && <button className="export-choice" onClick={() => void exportResource()}><div className="format-chip">ZIP</div><div><b>{resourcePackage.name} · FiveM resource</b><small>{resourcePackage.files.length} source files · original YFT/YTD files included · texture replacements saved to YTD{resourcePackage.hasManifest ? ' · original manifest preserved' : ' · fxmanifest.lua added on export'}</small></div><ChevronRight size={15} /></button>}{root && <><label className="form-label">Filename<input value={exportName} onChange={(e) => setExportName(e.target.value)} data-testid="input-export-filename" /></label><div className="export-options">{(['glb', 'gltf', 'obj', 'stl'] as const).map((kind) => <button key={kind} className="export-choice" onClick={() => void exportScene(kind)}><div className="format-chip">{kind.toUpperCase()}</div><div><b>{kind === 'glb' ? 'GLB · Single file' : kind === 'gltf' ? 'GLTF · ZIP package' : kind === 'obj' ? 'OBJ + MTL · ZIP' : 'STL · Geometry only'}</b><small>{kind === 'glb' ? 'Binary scene with embedded materials and textures' : kind === 'gltf' ? 'JSON scene packaged with its resources' : kind === 'obj' ? 'Mesh data and a basic material definition' : 'Warning: materials and textures are not included'}</small></div><ChevronRight size={15} /></button>)}</div><div className="native-warning"><ShieldCheck size={14} /><span>Standard 3D exports are <b>not native GTA assets.</b> Specialist tools are needed to convert them. YFT geometry edits remain in the GLB export.</span></div></>}</section></div>}
      {projectOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) setProjectOpen(false); }}><section className="dialog projects-dialog" role="dialog" aria-modal="true" aria-labelledby="projects-title"><div className="dialog-header"><div><span className="eyebrow">THIS BROWSER ONLY</span><h2 id="projects-title">Local projects</h2></div><IconButton icon={X} label="Close projects" onClick={() => setProjectOpen(false)} /></div><p className="dialog-intro">Project data is stored in this browser's local database. It is never uploaded.</p><div className="project-list scrollbar-thin">{projects.length ? projects.map((project) => <button className="project-row" key={project.id} onClick={() => void openLocal(project.id)}><div className="project-file"><Box size={16} /></div><div><b>{project.name}</b><small>Saved {new Date(project.updatedAt).toLocaleString()} · {project.sources.length} source file{project.sources.length === 1 ? '' : 's'}</small></div><ChevronRight size={14} /></button>) : <div className="project-list-empty"><HardDrive size={19} /><b>No saved projects</b><span>Save a scene locally to find it here.</span></div>}</div><div className="dialog-footer"><button className="secondary-action" onClick={() => { setProjectOpen(false); clearScene(); }}><FilePlus2 size={14} /> New project</button><button className="primary-action" onClick={() => setProjectOpen(false)}>Done</button></div></section></div>}
      <ResourcePackageDialog
        open={resourceOpen}
        packageName={resourcePackage?.name || ''}
        files={resourcePackage?.files.map(({ path, file, kind }) => ({ path, size: file.size, kind })) || []}
        hasManifest={Boolean(resourcePackage?.hasManifest)}
        onClose={closeResourceDialog}
        onImportZip={() => resourcePicker.current?.click()}
        onImportFolder={() => resourceFolderPicker.current?.click()}
        onExport={() => void exportResource()}
        onClear={() => { setResourcePackage(null); setNotice({ kind: 'info', message: 'Resource package cleared.' }); }}
      />
      {textureStudioOpen && resourcePackage && <NativeTextureStudioDialog
        resource={resourcePackage}
        onClose={() => setTextureStudioOpen(false)}
        onReplace={replaceNativeFile}
        onPreviewModel={previewNativeModel}
      />}
    </main>
  );
}

function SceneTree({ root, selectedId, query, onSelect, onRename, onDuplicate, onDelete, onVisible, onLock }: { root: THREE.Object3D; selectedId: string | null; query: string; onSelect: (object: THREE.Object3D) => void; onRename: (object: THREE.Object3D) => void; onDuplicate: (object: THREE.Object3D) => void; onDelete: (object: THREE.Object3D) => void; onVisible: (object: THREE.Object3D) => void; onLock: (object: THREE.Object3D) => void }) {
  return <div className="tree-list"><TreeNode item={root} depth={0} query={query} selectedId={selectedId} onSelect={onSelect} onRename={onRename} onDuplicate={onDuplicate} onDelete={onDelete} onVisible={onVisible} onLock={onLock} /></div>;
}
function TreeNode(props: { item: THREE.Object3D; depth: number; query: string; selectedId: string | null; onSelect: (o: THREE.Object3D) => void; onRename: (o: THREE.Object3D) => void; onDuplicate: (o: THREE.Object3D) => void; onDelete: (o: THREE.Object3D) => void; onVisible: (o: THREE.Object3D) => void; onLock: (o: THREE.Object3D) => void }) {
  const { item, depth, selectedId, query } = props;
  const [expanded, setExpanded] = useState(true);
  const [context, setContext] = useState(false);
  const matches = (node: THREE.Object3D): boolean => node.name.toLowerCase().includes(query.toLowerCase()) || node.children.some((child) => !child.name.startsWith('__forge') && matches(child));
  const children = item.children.filter((child) => !child.name.startsWith('__forge') && (!query || matches(child)));
  const Icon = (item as THREE.Mesh).isMesh ? Box : Layers3;
  return <div className="tree-branch"><div className={`tree-row${selectedId === item.uuid ? ' selected' : ''}`} style={{ paddingLeft: `${depth * 13 + 6}px` }} onContextMenu={(e) => { e.preventDefault(); setContext(!context); }}>
    <button className="tree-expander" onClick={() => setExpanded(!expanded)} aria-label={`${expanded ? 'Collapse' : 'Expand'} ${item.name || 'object'}`} disabled={!children.length}>{children.length ? expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} /> : <span className="expander-placeholder" />}</button>
    <button className="tree-select" onClick={() => props.onSelect(item)}><Icon size={13} /><span>{item.name || item.type}</span></button>
    <div className="tree-controls"><button title={item.visible ? 'Hide object' : 'Show object'} aria-label={item.visible ? 'Hide object' : 'Show object'} onClick={() => props.onVisible(item)}>{item.visible ? <Eye size={12} /> : <EyeOff size={12} />}</button><button title={item.userData.forgeLocked ? 'Unlock object' : 'Lock object'} aria-label={item.userData.forgeLocked ? 'Unlock object' : 'Lock object'} onClick={() => props.onLock(item)}>{item.userData.forgeLocked ? <LockKeyhole size={12} /> : <LockKeyhole size={12} />}</button><button title="More object actions" aria-label="More object actions" onClick={() => setContext(!context)}><Menu size={12} /></button></div>
    {context && <div className="tree-context"><button onClick={() => { setContext(false); props.onRename(item); }}>Rename</button><button onClick={() => { setContext(false); props.onDuplicate(item); }}>Duplicate</button><button onClick={() => { setContext(false); props.onDelete(item); }}>Delete</button></div>}
  </div>{expanded && children.map((child) => <TreeNode key={child.uuid} {...props} item={child} depth={depth + 1} />)}</div>;
}
function TransformSection({ title, values, onChange }: { title: string; values: number[]; onChange: (axis: 'x' | 'y' | 'z', value: number) => void }) {
  return <div className="transform-section"><div className="transform-title">{title}<button title={`Reset ${title.toLowerCase()}`} aria-label={`Reset ${title.toLowerCase()}`} onClick={() => { (['x', 'y', 'z'] as const).forEach((axis, i) => onChange(axis, title === 'Scale' ? 1 : 0)); }}><RotateCcw size={11} /></button></div><div className="axis-inputs">{(['x', 'y', 'z'] as const).map((axis, i) => <label key={axis}><span className={`axis-${axis}`}>{axis.toUpperCase()}</span><input type="number" step={title === 'Rotation' ? 1 : .01} value={Number(values[i].toFixed(3))} onChange={(e) => onChange(axis, Number(e.target.value))} /></label>)}</div></div>;
}
function InfoRow({ label, value }: { label: string; value: string }) { return <div className="info-row"><span>{label}</span><code>{value}</code></div>; }
function RangeField({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) { return <label className="range-field"><span>{label}</span><div><input type="range" min="0" max="1" step=".01" value={value} onChange={(e) => onChange(Number(e.target.value))} /><code>{value.toFixed(2)}</code></div></label>; }

export default App;
