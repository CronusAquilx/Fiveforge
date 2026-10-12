import { LoaderCircle, Puzzle, ToggleLeft, ToggleRight } from 'lucide-react';

export type VehiclePartControl = {
  id: string;
  label: string;
  category?: 'extra' | 'inline' | 'addon';
  enabled: boolean;
  loading?: boolean;
  disabled?: boolean;
  error?: string;
  source?: string;
};

type VehiclePartsPanelProps = {
  inlineParts: VehiclePartControl[];
  addonParts: VehiclePartControl[];
  onToggleInline: (id: string) => void;
  onToggleAddon: (id: string) => void;
};

function PartRow({ part, onToggle }: { part: VehiclePartControl; onToggle: () => void }) {
  return (
    <div className={`vehicle-part-row${part.error ? ' has-error' : ''}`}>
      <button
        type="button"
        className="vehicle-part-toggle"
        aria-label={`${part.enabled ? 'Turn off' : 'Turn on'} ${part.label}`}
        aria-pressed={part.enabled}
        disabled={part.loading || part.disabled}
        onClick={onToggle}
      >
        <span className="vehicle-part-state">{part.loading ? <LoaderCircle className="part-spinner" size={14} /> : part.enabled ? <ToggleRight size={17} /> : <ToggleLeft size={17} />}</span>
        <span className="vehicle-part-copy">
          <b>{part.label}</b>
          {part.loading ? <small>Converting part…</small> : part.error ? <small>{part.error}</small> : part.source ? <small>{part.source}</small> : null}
        </span>
      </button>
    </div>
  );
}

export default function VehiclePartsPanel({ inlineParts, addonParts, onToggleInline, onToggleAddon }: VehiclePartsPanelProps) {
  if (!inlineParts.length && !addonParts.length) return null;
  const extras = inlineParts.filter((part) => part.category === 'extra');
  const inlineMods = inlineParts.filter((part) => part.category !== 'extra');
  return (
    <section className="inspector-section vehicle-parts-section" aria-label="Vehicle options">
      <div className="section-title vehicle-parts-heading"><span><Puzzle size={12} /> VEHICLE OPTIONS</span><span>{inlineParts.length + addonParts.length}</span></div>
      {extras.length > 0 && <div className="vehicle-part-group">
        <div className="vehicle-part-group-title">VEHICLE EXTRAS</div>
        {extras.map((part) => <PartRow key={part.id} part={part} onToggle={() => onToggleInline(part.id)} />)}
      </div>}
      {inlineMods.length > 0 && <div className="vehicle-part-group">
        <div className="vehicle-part-group-title">INLINE MODS</div>
        {inlineMods.map((part) => <PartRow key={part.id} part={part} onToggle={() => onToggleInline(part.id)} />)}
      </div>}
      {addonParts.length > 0 && <div className="vehicle-part-group">
        <div className="vehicle-part-group-title">TUNING PART FILES</div>
        {addonParts.map((part) => <PartRow key={part.id} part={part} onToggle={() => onToggleAddon(part.id)} />)}
      </div>}
      <p className="vehicle-parts-note">Preview extras start hidden. Exported FiveM resources also hide detected IDs on spawn; tuning files load only when enabled.</p>
    </section>
  );
}
