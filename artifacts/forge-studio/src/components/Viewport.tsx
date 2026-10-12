import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

type Props = {
  root: THREE.Object3D | null;
  grid: boolean;
  axes: boolean;
  wireframe: boolean;
  orthographic: boolean;
  background: string;
  onSelect: (object: THREE.Object3D) => void;
};

export function Viewport({ root, grid, axes, wireframe, orthographic, background, onSelect }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const [rendererError, setRendererError] = useState(false);
  const api = useRef<{ renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.Camera; controls: OrbitControls; model: THREE.Object3D | null } | null>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  useEffect(() => {
    if (!host.current) return;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(background);
    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 10000);
    camera.position.set(4.2, 3.2, 5.4);
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false }); }
    catch { setRendererError(true); return; }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    host.current.appendChild(renderer.domElement);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.target.set(0, 0.65, 0);
    scene.add(new THREE.HemisphereLight(0xcbd5e2, 0x292721, 2.0));
    const key = new THREE.DirectionalLight(0xfff3dc, 3.4);
    key.position.set(4, 7, 5); scene.add(key);
    const fill = new THREE.DirectionalLight(0x9aacc8, 1.2);
    fill.position.set(-5, 2, -4); scene.add(fill);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshStandardMaterial({ color: 0x191a1c, roughness: 1, metalness: 0 }));
    floor.rotation.x = -Math.PI / 2; floor.position.y = -0.002; floor.name = '__forge_floor'; scene.add(floor);
    const gridHelper = new THREE.GridHelper(20, 40, 0x514c40, 0x343536);
    gridHelper.name = '__forge_grid'; scene.add(gridHelper);
    const axesHelper = new THREE.AxesHelper(1.4); axesHelper.name = '__forge_axes'; scene.add(axesHelper);
    const resize = () => {
      if (!host.current) return;
      const w = host.current.clientWidth; const h = host.current.clientHeight;
      renderer.setSize(w, h, false);
      const active = api.current?.camera;
      if (active instanceof THREE.PerspectiveCamera) { active.aspect = w / Math.max(h, 1); active.updateProjectionMatrix(); }
    };
    const observer = new ResizeObserver(resize); observer.observe(host.current); resize();
    const raycaster = new THREE.Raycaster(); const pointer = new THREE.Vector2();
    const click = (event: PointerEvent) => {
      if (!host.current || !api.current?.model) return;
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(pointer, api.current.camera);
      const hits = raycaster.intersectObject(api.current.model, true);
      const mesh = hits.find((hit) => (hit.object as THREE.Mesh).isMesh)?.object;
      if (mesh) onSelectRef.current(mesh);
    };
    renderer.domElement.addEventListener('pointerup', click);
    const onContextLost = (event: Event) => {
      event.preventDefault();
      setRendererError(true);
    };
    const onContextRestored = () => {
      try {
        resize();
        setRendererError(false);
      } catch {
        setRendererError(true);
      }
    };
    renderer.domElement.addEventListener('webglcontextlost', onContextLost, false);
    renderer.domElement.addEventListener('webglcontextrestored', onContextRestored, false);
    const fit = () => {
      const current = api.current;
      if (!current?.model) return;
      current.model.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(current.model);
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const radius = Math.max(size.x, size.y, size.z, 0.5);
      current.controls.target.copy(center);
      const direction = current.camera.position.clone().sub(current.controls.target).normalize();
      if (current.camera instanceof THREE.OrthographicCamera) {
        const span = radius * 1.9;
        current.camera.left = -span; current.camera.right = span; current.camera.top = span; current.camera.bottom = -span;
      }
      current.camera.position.copy(center).add(direction.multiplyScalar(radius * 2.8));
      if (current.camera instanceof THREE.PerspectiveCamera || current.camera instanceof THREE.OrthographicCamera) current.camera.updateProjectionMatrix();
      current.controls.update();
    };
    window.addEventListener('forge-fit-view', fit);
    api.current = { renderer, scene, camera, controls, model: null };
    let frame = 0;
    const render = () => { frame = requestAnimationFrame(render); controls.update(); renderer.render(scene, camera); };
    render();
    return () => {
      cancelAnimationFrame(frame); observer.disconnect(); renderer.domElement.removeEventListener('pointerup', click);
      renderer.domElement.removeEventListener('webglcontextlost', onContextLost, false);
      renderer.domElement.removeEventListener('webglcontextrestored', onContextRestored, false);
      window.removeEventListener('forge-fit-view', fit);
      controls.dispose(); renderer.dispose(); renderer.domElement.remove(); api.current = null;
    };
  }, []);

  useEffect(() => {
    const current = api.current; if (!current) return;
    if (current.model) { current.scene.remove(current.model); }
    current.model = root;
    if (root) {
      current.scene.add(root);
      root.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(root);
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      current.controls.target.copy(center);
      const max = Math.max(size.x, size.y, size.z, 1);
      current.camera.position.set(center.x + max * 1.6, center.y + max * 1.05, center.z + max * 1.8);
      current.controls.update();
    }
  }, [root]);
  useEffect(() => { const a = api.current; if (!a) return; a.scene.background = new THREE.Color(background); }, [background]);
  useEffect(() => { const a = api.current; if (!a) return; a.scene.getObjectByName('__forge_grid')!.visible = grid; a.scene.getObjectByName('__forge_axes')!.visible = axes; }, [grid, axes]);
  useEffect(() => {
    if (!root) return;
    root.traverse((item) => { const mesh = item as THREE.Mesh; if (!mesh.isMesh) return; const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]; mats.forEach((mat: any) => { if ('wireframe' in mat) mat.wireframe = wireframe; }); });
  }, [root, wireframe]);
  useEffect(() => {
    const current = api.current; if (!current) return;
    const old = current.camera;
    if (orthographic && !(old instanceof THREE.OrthographicCamera)) {
      const camera = new THREE.OrthographicCamera(-5, 5, 5, -5, 0.01, 10000); camera.position.copy(old.position); camera.quaternion.copy(old.quaternion); camera.updateProjectionMatrix(); current.camera = camera; current.controls.object = camera; current.controls.update();
    } else if (!orthographic && !(old instanceof THREE.PerspectiveCamera)) {
      const box = root ? new THREE.Box3().setFromObject(root) : new THREE.Box3(new THREE.Vector3(-2,-2,-2), new THREE.Vector3(2,2,2));
      const size = box.getSize(new THREE.Vector3()).length() || 6;
      const camera = new THREE.PerspectiveCamera(45, (host.current?.clientWidth || 1) / (host.current?.clientHeight || 1), .01, 10000);
      camera.position.copy(old.position); camera.position.setLength(size * 1.3); camera.updateProjectionMatrix(); current.camera = camera; current.controls.object = camera; current.controls.update();
    }
  }, [orthographic, root]);
  return <div ref={host} className="viewport-canvas" aria-label="Interactive 3D viewport">{rendererError && <div className="webgl-error" role="alert"><BoxFallback /><b>WebGL is unavailable</b><span>Enable hardware acceleration or open this workshop in a WebGL-capable browser.</span></div>}</div>;
}

function BoxFallback() { return <div className="webgl-error-mark" aria-hidden="true">3D</div>; }
