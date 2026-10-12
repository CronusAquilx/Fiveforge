import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Download, ImagePlus, LoaderCircle, RefreshCw, X } from 'lucide-react';
import type { ResourcePackage } from '@/lib/resource-package';
import { previewNativeYft, type NativeYftPreview } from '@/lib/native-yft-preview';

type NativeTexture = {
  name: string;
  width: number;
  height: number;
  format: string;
  mipCount: number;
  previewBase64: string | null;
  previewError: string | null;
};

type Props = {
  resource: ResourcePackage;
  onClose: () => void;
  onReplace: (path: string, file: File) => void;
  onPreviewModel: (preview: NativeYftPreview, sourcePath: string, textureFiles: File[]) => Promise<void>;
};

const MAX_NATIVE_UPLOAD = 250 * 1024 * 1024;

function extension(path: string) {
  return path.split('.').pop()?.toLowerCase() || '';
}

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

async function readResponse<T>(response: Response): Promise<T> {
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error || 'The GTA asset could not be read.');
  return data;
}

export default function NativeTextureStudioDialog({ resource, onClose, onReplace, onPreviewModel }: Props) {
  const imagePicker = useRef<HTMLInputElement>(null);
  const ytdFiles = useMemo(() => resource.files.filter((item) => extension(item.path) === 'ytd'), [resource]);
  const yftFiles = useMemo(() => resource.files.filter((item) => extension(item.path) === 'yft'), [resource]);
  const [selectedYtdPath, setSelectedYtdPath] = useState(ytdFiles[0]?.path || '');
  const [selectedYftPath, setSelectedYftPath] = useState(yftFiles[0]?.path || '');
  const [textures, setTextures] = useState<NativeTexture[]>([]);
  const [selectedTexture, setSelectedTexture] = useState('');
  const [replacement, setReplacement] = useState<File | null>(null);
  const [loadingTextures, setLoadingTextures] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const selectedYtd = ytdFiles.find((item) => item.path === selectedYtdPath);
  const selectedYft = yftFiles.find((item) => item.path === selectedYftPath);
  const activeTexture = textures.find((texture) => texture.name === selectedTexture) || textures[0];
  const selectedImagePreview = activeTexture?.previewBase64
    ? `data:image/png;base64,${activeTexture.previewBase64}`
    : '';

  useEffect(() => {
    let current = true;
    setTextures([]);
    setSelectedTexture('');
    setReplacement(null);
    if (!selectedYtd) return () => { current = false; };
    if (selectedYtd.file.size > MAX_NATIVE_UPLOAD) {
      setError('This YTD is over 250 MB and cannot be previewed here.');
      return () => { current = false; };
    }

    setLoadingTextures(true);
    void (async () => {
      try {
        const response = await fetch('/api/native-assets/decode-ytd', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fileName: selectedYtd.path, dataBase64: await toBase64(selectedYtd.file) }),
        });
        const data = await readResponse<{ textures: NativeTexture[] }>(response);
        if (!current) return;
        setTextures(data.textures);
        setSelectedTexture(data.textures.find((texture) => texture.previewBase64)?.name || data.textures[0]?.name || '');
      } catch (cause) {
        if (current) setError(cause instanceof Error ? cause.message : 'Could not decode this YTD.');
      } finally {
        if (current) setLoadingTextures(false);
      }
    })();

    return () => { current = false; };
  }, [selectedYtd?.path, selectedYtd?.file]);

  const applyReplacement = async () => {
    if (!selectedYtd || !activeTexture || !replacement) return;
    if (selectedYtd.file.size + replacement.size > MAX_NATIVE_UPLOAD) {
      setError('The YTD and replacement image exceed the 250 MB processing limit.');
      return;
    }
    setBusy('Rebuilding texture dictionary');
    setError('');
    setSuccess('');
    try {
      const [dataBase64, imageBase64] = await Promise.all([toBase64(selectedYtd.file), toBase64(replacement)]);
      const response = await fetch('/api/native-assets/replace-ytd', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileName: selectedYtd.path,
          dataBase64,
          textureName: activeTexture.name,
          imageBase64,
        }),
      });
      const data = await readResponse<{ dataBase64: string; texture: NativeTexture }>(response);
      const file = new File(
        [fromBase64(data.dataBase64)],
        selectedYtd.file.name,
        { type: 'application/octet-stream', lastModified: Date.now() },
      );
      onReplace(selectedYtd.path, file);
      setReplacement(null);
      setSuccess(`${activeTexture.name} updated. Export the resource ZIP to save the rebuilt YTD.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not rebuild this YTD.');
    } finally {
      setBusy('');
    }
  };

  const previewVehicle = async () => {
    if (!selectedYft) return;
    setBusy('Preparing 3D vehicle preview');
    setError('');
    setSuccess('');
    try {
      const modelStem = selectedYft.path.split('/').pop()?.replace(/\.yft$/i, '').replace(/_hi$/i, '').toLocaleLowerCase() || '';
      const orderedYtds = [
        ...ytdFiles.filter((item) => item.path.split('/').pop()?.replace(/\.ytd$/i, '').toLocaleLowerCase() === modelStem),
        ...ytdFiles.filter((item) => item.path.split('/').pop()?.replace(/\.ytd$/i, '').toLocaleLowerCase() !== modelStem),
      ];
      const previewYtds: File[] = [];
      let totalBytes = selectedYft.file.size;
      for (const item of orderedYtds) {
        if (previewYtds.length >= 24 || totalBytes + item.file.size > MAX_NATIVE_UPLOAD) continue;
        previewYtds.push(item.file);
        totalBytes += item.file.size;
      }
      const preview = await previewNativeYft(selectedYft.file, previewYtds);
      await onPreviewModel(preview, selectedYft.path, previewYtds);
      const textureStatus = preview.textureCount
        ? `${preview.textureCount} YTD textures matched`
        : previewYtds.length
          ? 'no YTD texture names matched the model'
          : 'no matching YTD was available';
      setSuccess(`Showing ${preview.meshCount} YFT meshes; ${textureStatus}. Supported whole-mesh transforms and hide/delete edits rebuild into native YFT files in the resource ZIP. GLB remains a separate preview/interchange export.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not preview this YFT.');
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <section className="dialog native-texture-dialog" role="dialog" aria-modal="true" aria-labelledby="native-texture-title">
        <header className="nt-head">
          <div><span className="eyebrow">FIVEM ASSET WORKSPACE</span><h2 id="native-texture-title">Texture studio</h2></div>
          <button type="button" className="icon-button" aria-label="Close texture studio" onClick={onClose} disabled={!!busy}><X size={16} /></button>
        </header>
        <div className="nt-content">
          <div className="nt-controls">
            {ytdFiles.length > 0 && <label>Texture dictionary
              <select value={selectedYtdPath} onChange={(event) => { setSelectedYtdPath(event.target.value); setError(''); setSuccess(''); }}>
                {ytdFiles.map((item) => <option key={item.path} value={item.path}>{item.path}</option>)}
              </select>
            </label>}
            {yftFiles.length > 0 && <label>Vehicle model
              <select value={selectedYftPath} onChange={(event) => { setSelectedYftPath(event.target.value); setError(''); setSuccess(''); }}>
                {yftFiles.map((item) => <option key={item.path} value={item.path}>{item.path}</option>)}
              </select>
            </label>}
            {selectedYft && <button className="nt-preview-button" type="button" onClick={() => void previewVehicle()} disabled={!!busy}>
              {busy === 'Preparing 3D vehicle preview' ? <LoaderCircle className="nt-spin" size={14} /> : <Box size={14} />}
              Preview YFT in 3D
            </button>}
          </div>

          {loadingTextures && <div className="nt-loading"><LoaderCircle className="nt-spin" size={17} /> Reading native texture dictionary…</div>}
          {!loadingTextures && ytdFiles.length > 0 && textures.length === 0 && !error && <div className="nt-empty">No previewable textures found in this YTD.</div>}
          {!loadingTextures && textures.length > 0 && (
            <div className="nt-editor">
              <div className="nt-gallery" role="list" aria-label="Textures in this dictionary">
                {textures.map((texture) => (
                  <button
                    className={`nt-tile${texture.name === activeTexture?.name ? ' selected' : ''}${!texture.previewBase64 ? ' unavailable' : ''}`}
                    type="button"
                    role="listitem"
                    key={texture.name}
                    onClick={() => { setSelectedTexture(texture.name); setReplacement(null); setError(''); setSuccess(''); }}
                    title={texture.previewError || texture.name}
                  >
                    {texture.previewBase64
                      ? <img src={`data:image/png;base64,${texture.previewBase64}`} alt="" />
                      : <span className="nt-no-image">NO<br />PREVIEW</span>}
                    <span>{texture.name}</span>
                    <small>{texture.width} × {texture.height}</small>
                  </button>
                ))}
              </div>
              <div className="nt-detail">
                {activeTexture?.previewBase64
                  ? <img className="nt-large-preview" src={selectedImagePreview} alt={`${activeTexture.name} texture preview`} />
                  : <div className="nt-large-empty">{activeTexture?.previewError || 'Select a decodable texture to preview it.'}</div>}
                {activeTexture && <div className="nt-texture-info">
                  <div><b>{activeTexture.name}</b><small>{activeTexture.width} × {activeTexture.height} · {activeTexture.format} · {activeTexture.mipCount} mips</small></div>
                  <input
                    ref={imagePicker}
                    className="visually-hidden"
                    type="file"
                    accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp"
                    onChange={(event) => { setReplacement(event.target.files?.[0] || null); setError(''); setSuccess(''); event.target.value = ''; }}
                  />
                  <div className="nt-actions">
                    <button type="button" onClick={() => imagePicker.current?.click()} disabled={!activeTexture.previewBase64 || !!busy}><ImagePlus size={13} /> {replacement ? 'Choose another' : 'Replace from image'}</button>
                    {replacement && <button type="button" className="nt-apply" onClick={() => void applyReplacement()} disabled={!!busy}>
                      {busy === 'Rebuilding texture dictionary' ? <LoaderCircle className="nt-spin" size={13} /> : <RefreshCw size={13} />}
                      Rebuild YTD
                    </button>}
                  </div>
                  {replacement && <small className="nt-replacement-name">{replacement.name}</small>}
                </div>}
              </div>
            </div>
          )}

          {!loadingTextures && ytdFiles.length === 0 && (
            <div className="nt-empty">No YTD texture dictionary is included in this resource. Add its matching YTD to preview or replace vehicle textures.</div>
          )}
          {yftFiles.length > 0 && <p className="nt-note">YFT preview loads into the regular editor with matched YTD textures. Resource export can rebuild whole-mesh transforms and hide/delete edits as native YFT; partial face-group edits and preview-only material or finish changes block native YFT rebuild. Replacing a texture rebuilds the selected YTD in this resource. Collision and vehicle physics are preserved unchanged.</p>}
          <p className="nt-note">Native files are sent to this app’s parser in memory for preview or rebuilding, then discarded. They are not saved by the API.</p>
          {error && <div className="nt-message error" role="alert">{error}</div>}
          {success && <div className="nt-message success" role="status">{success}</div>}
        </div>
        <footer className="nt-foot">
          <span>{resource.name} · changes stay in this resource until export</span>
          <div>
            {busy && <span className="nt-busy"><LoaderCircle className="nt-spin" size={13} />{busy}</span>}
            <button type="button" className="nt-close" onClick={onClose} disabled={!!busy}><Download size={13} /> Done</button>
          </div>
        </footer>
      </section>
    </div>
  );
}
