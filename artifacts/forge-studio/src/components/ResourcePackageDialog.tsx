import { useEffect, useMemo, useRef } from 'react';
import {
  AlertTriangle,
  Archive,
  Check,
  Code2,
  Download,
  File,
  FileCode2,
  FileText,
  FolderOpen,
  HardDrive,
  Package,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';

export type ResourcePackageFile = {
  path: string;
  size: number;
  kind: 'native' | 'meta' | 'manifest' | 'script' | 'other';
};

/**
 * Props for the FiveM resource packaging workflow dialog.
 * Import and export work is owned by the parent application.
 */
export interface ResourcePackageDialogProps {
  open: boolean;
  packageName: string;
  files: ResourcePackageFile[];
  hasManifest: boolean;
  onClose(): void;
  onImportZip(): void;
  onImportFolder(): void;
  onExport(): void;
  onClear(): void;
}

const kindDetails: Record<ResourcePackageFile['kind'], { label: string; Icon: typeof File; tone: string }> = {
  native: { label: 'NATIVE', Icon: HardDrive, tone: 'native' },
  meta: { label: 'META', Icon: FileText, tone: 'meta' },
  manifest: { label: 'MANIFEST', Icon: FileCode2, tone: 'manifest' },
  script: { label: 'SCRIPT', Icon: Code2, tone: 'script' },
  other: { label: 'FILE', Icon: File, tone: 'other' },
};

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function ResourcePackageDialog({
  open,
  packageName,
  files,
  hasManifest,
  onClose,
  onImportZip,
  onImportFolder,
  onExport,
  onClear,
}: ResourcePackageDialogProps) {
  const closeButton = useRef<HTMLButtonElement>(null);
  const totalSize = useMemo(() => files.reduce((sum, file) => sum + file.size, 0), [files]);
  const nativeCount = useMemo(() => files.filter((file) => file.kind === 'native').length, [files]);

  useEffect(() => {
    if (!open) return;
    closeButton.current?.focus();
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', dismiss);
    return () => window.removeEventListener('keydown', dismiss);
  }, [open, onClose]);

  if (!open) return null;

  const loaded = files.length > 0;
  const name = packageName.trim() || 'Untitled resource';

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="dialog resource-package-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="resource-package-title"
        aria-describedby="resource-package-description"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <style>{`
          .resource-package-dialog{width:min(700px,100%);padding:0;display:flex;flex-direction:column;overflow:hidden}
          .rp-head{display:flex;align-items:flex-start;justify-content:space-between;padding:18px 20px 15px;border-bottom:1px solid #303133}
          .rp-titleline{display:flex;align-items:center;gap:10px}
          .rp-mark{width:32px;height:32px;display:grid;place-items:center;background:#29261f;border:1px solid #554832;color:#c6a35d}
          .rp-kicker{font:8px var(--app-font-mono);letter-spacing:.14em;color:#b79655}
          .rp-head h2{margin:4px 0 0;color:#e2e2de;font-size:17px;font-weight:600;letter-spacing:-.035em}
          .rp-close{width:28px;height:27px;display:grid;place-items:center;background:transparent;border:1px solid transparent;color:#898b8c}
          .rp-close:hover{background:#28292b;border-color:#414244;color:#e1e1df}
          .rp-content{padding:16px 20px 18px;overflow:auto;min-height:0}
          .rp-description{margin:0 0 15px;color:#999b9c;font-size:10px;line-height:1.65}
          .rp-summary{display:flex;align-items:center;gap:9px;flex-wrap:wrap;padding:10px 11px;background:#202123;border:1px solid #37393b;margin-bottom:12px}
          .rp-name{flex:1;min-width:140px;color:#e0e0dd;font-size:11px;font-weight:600;overflow-wrap:anywhere}
          .rp-pill{display:inline-flex;align-items:center;gap:5px;padding:4px 6px;border:1px solid #414244;color:#999b9c;font:8px var(--app-font-mono);letter-spacing:.035em}
          .rp-pill.good{color:#aab596;border-color:#46503d;background:#252922}
          .rp-pill.missing{color:#c49a71;border-color:#594733;background:#29241f}
          .rp-path-label{display:flex;align-items:center;justify-content:space-between;margin:14px 1px 7px}
          .rp-path-label strong{font:9px var(--app-font-mono);letter-spacing:.1em;color:#a6a8a8}
          .rp-path-label span{font:8px var(--app-font-mono);color:#777a7c}
          .rp-file-list{max-height:270px;overflow:auto;border:1px solid #353739;background:#171819;scrollbar-width:thin;scrollbar-color:#48494a #1b1c1d}
          .rp-file-row{min-height:35px;display:grid;grid-template-columns:18px minmax(0,1fr) auto auto;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid #282a2b}
          .rp-file-row:last-child{border-bottom:0}
          .rp-file-icon{color:#898b8c}
          .rp-file-path{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#c7c8c7;font:9px var(--app-font-mono)}
          .rp-file-kind{font:7px var(--app-font-mono);letter-spacing:.04em;color:#8c8e8f;padding:3px 4px;border:1px solid #3b3d3f}
          .rp-file-kind.native{color:#c4a568;border-color:#554a34}
          .rp-file-kind.manifest{color:#aab596;border-color:#48503f}
          .rp-file-size{min-width:49px;text-align:right;color:#777a7b;font:8px var(--app-font-mono)}
          .rp-empty{min-height:205px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:25px;border:1px dashed #454648;background:#1a1b1d}
          .rp-empty-icon{width:40px;height:40px;display:grid;place-items:center;border:1px solid #4a4335;background:#25231f;color:#c0a05b}
          .rp-empty h3{margin:12px 0 5px;color:#d4d4d1;font-size:12px;font-weight:600}
          .rp-empty p{max-width:320px;margin:0;color:#858789;font-size:9px;line-height:1.65}
          .rp-import-actions{display:flex;gap:7px;margin-top:15px;flex-wrap:wrap;justify-content:center}
          .rp-import-actions button,.rp-button{height:30px;display:inline-flex;align-items:center;justify-content:center;gap:7px;padding:0 10px;border:1px solid #454648;background:#252628;color:#c8c9c8;font-size:9px}
          .rp-import-actions button:hover:not(:disabled),.rp-button:hover:not(:disabled){border-color:#8a7144;color:#ebce85;background:#292825}
          .rp-native-note{display:flex;align-items:flex-start;gap:8px;margin-top:12px;padding:9px 10px;background:#27251f;border:1px solid #4b4330;color:#bcb29b;font-size:9px;line-height:1.55}
          .rp-native-note svg{flex:none;margin-top:1px;color:#c4a358}
          .rp-native-note b{color:#e0c981;font-weight:600}
          .rp-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 20px;border-top:1px solid #303133;background:#191a1c}
          .rp-foot-meta{color:#818385;font:8px var(--app-font-mono);letter-spacing:.035em}
          .rp-foot-actions{display:flex;align-items:center;gap:6px}
          .rp-button.clear{color:#b98e82}
          .rp-button.export{background:#b7914b;border-color:#b7914b;color:#171819;font-weight:700}
          .rp-button.export:hover:not(:disabled){background:#c5a45e;border-color:#c5a45e;color:#151617}
          @media(max-width:560px){.resource-package-dialog{max-height:calc(100dvh - 24px)}.rp-head{padding:15px}.rp-content{padding:13px 15px}.rp-foot{padding:11px 15px;align-items:flex-start;flex-direction:column}.rp-foot-actions{width:100%}.rp-foot-actions button{flex:1}.rp-file-row{grid-template-columns:16px minmax(0,1fr) auto}.rp-file-size{display:none}}
        `}</style>

        <header className="rp-head">
          <div className="rp-titleline">
            <div className="rp-mark"><Package size={16} strokeWidth={1.8} /></div>
            <div>
              <div className="rp-kicker">FIVEM RESOURCE</div>
              <h2 id="resource-package-title">Package resource</h2>
            </div>
          </div>
          <button ref={closeButton} className="rp-close" type="button" onClick={onClose} aria-label="Close resource package dialog">
            <X size={15} />
          </button>
        </header>

        <div className="rp-content">
          <p className="rp-description" id="resource-package-description">
            Bring in a resource folder or ZIP, check its paths and manifest, then export a resource ZIP.
          </p>

          {!loaded ? (
            <div className="rp-empty">
              <div className="rp-empty-icon"><Archive size={18} strokeWidth={1.7} /></div>
              <h3>No resource loaded</h3>
              <p>Choose a FiveM resource ZIP or a folder to inspect its contents before packaging.</p>
              <div className="rp-import-actions">
                <button type="button" onClick={onImportZip}><Archive size={13} /> Import ZIP</button>
                <button type="button" onClick={onImportFolder}><FolderOpen size={13} /> Choose folder</button>
              </div>
            </div>
          ) : (
            <>
              <div className="rp-summary">
                <span className="rp-name">{name}</span>
                <span className={`rp-pill ${hasManifest ? 'good' : 'missing'}`}>
                  {hasManifest ? <Check size={11} /> : <AlertTriangle size={11} />}
                  {hasManifest ? 'MANIFEST FOUND' : 'MANIFEST MISSING'}
                </span>
                <span className="rp-pill">{files.length} FILE{files.length === 1 ? '' : 'S'}</span>
              </div>

              <div className="rp-path-label">
                <strong>RESOURCE PATHS</strong>
                <span>{nativeCount} NATIVE · {formatBytes(totalSize)}</span>
              </div>
              <div className="rp-file-list" role="list" aria-label="Resource file paths">
                {files.map((file, index) => {
                  const detail = kindDetails[file.kind];
                  const Icon = detail.Icon;
                  return (
                    <div className="rp-file-row" role="listitem" key={`${file.path}-${index}`} title={file.path}>
                      <Icon className="rp-file-icon" size={13} strokeWidth={1.7} aria-hidden="true" />
                      <span className="rp-file-path">{file.path}</span>
                      <span className={`rp-file-kind ${detail.tone}`}>{detail.label}</span>
                      <span className="rp-file-size">{formatBytes(file.size)}</span>
                    </div>
                  );
                })}
              </div>

              <div className="rp-native-note">
                <ShieldCheck size={14} />
                <span><b>Native GTA assets can be preserved and packaged.</b> They are not currently previewed or edited in-browser.</span>
              </div>
            </>
          )}
        </div>

        {loaded && (
          <footer className="rp-foot">
            <span className="rp-foot-meta">PACKAGE CONTENTS STAY LOCAL</span>
            <div className="rp-foot-actions">
              <button className="rp-button" type="button" onClick={onImportZip}><Archive size={12} /> ZIP</button>
              <button className="rp-button" type="button" onClick={onImportFolder}><FolderOpen size={12} /> Folder</button>
              <button className="rp-button clear" type="button" onClick={onClear}><Trash2 size={12} /> Clear</button>
              <button className="rp-button export" type="button" onClick={onExport}><Download size={13} /> Export ZIP</button>
            </div>
          </footer>
        )}
      </section>
    </div>
  );
}
