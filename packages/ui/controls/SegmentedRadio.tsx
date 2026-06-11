// Segmented radio control (the Tweaks "density" / "sidebar" selector).
// Host-protocol-free: pure value/onChange. Styling via global .twk-* classes.

export interface SegmentedRadioProps {
  label?: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
}

export function SegmentedRadio({ label, value, options, onChange }: SegmentedRadioProps) {
  const idx = Math.max(0, options.indexOf(value));
  const n = options.length;

  return (
    <div className="twk-row">
      {label ? (
        <div className="twk-lbl">
          <span>{label}</span>
          <span className="twk-val">{value}</span>
        </div>
      ) : null}
      <div role="radiogroup" className="twk-seg">
        <div
          className="twk-seg-thumb"
          style={{
            left: `calc(2px + ${idx} * (100% - 4px) / ${n})`,
            width: `calc((100% - 4px) / ${n})`,
          }}
        />
        {options.map((o) => (
          <button
            key={o}
            type="button"
            role="radio"
            aria-checked={o === value}
            onClick={() => onChange(o)}
          >
            {o}
          </button>
        ))}
      </div>
    </div>
  );
}
