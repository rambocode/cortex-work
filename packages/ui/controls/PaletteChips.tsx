// Brand-palette chip picker (the Tweaks "palette" selector).
// Each option renders a hero color + two stacked supporting colors.

export interface PaletteOption {
  id: string;
  name: string;
  colors: [string, string, string];
}

export interface PaletteChipsProps {
  label?: string;
  value: string;
  options: PaletteOption[];
  onChange: (id: string) => void;
}

export function PaletteChips({ label, value, options, onChange }: PaletteChipsProps) {
  return (
    <div className="twk-row">
      {label ? (
        <div className="twk-lbl">
          <span>{label}</span>
          <span className="twk-val">{value}</span>
        </div>
      ) : null}
      <div style={{ display: "flex", gap: 6 }}>
        {options.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => onChange(p.id)}
            data-on={value === p.id ? 1 : 0}
            className="twk-chip"
            style={{ background: p.colors[0], height: 40 }}
            title={p.name}
          >
            <span>
              <i style={{ background: p.colors[1] }} />
              <i style={{ background: p.colors[2] }} />
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
