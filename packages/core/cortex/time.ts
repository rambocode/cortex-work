// Demo clock: a fake monotonic time starting at 09:19 so freshly-sent messages
// flow naturally after the scripted ones. Module-scoped, not wall-clock.
let demoMinute = 9 * 60 + 19;

export function nowHHMM(): string {
  demoMinute += 1 + Math.floor(Math.random() * 2);
  const m = demoMinute % (24 * 60);
  const hh = Math.floor(m / 60);
  const mm = m % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(hh)}:${pad(mm)}`;
}

let counter = 0;
export function uid(prefix = "m"): string {
  counter += 1;
  return `${prefix}-${counter}-${Math.random().toString(36).slice(2)}`;
}
