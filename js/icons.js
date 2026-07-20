// DAPRES Parent Portal — icon set.
// Hand-drawn line icons (24x24 viewBox, stroke=currentColor, round caps) so
// they inherit whatever color/size CSS already applies to their container —
// no icon font, no external CDN dependency. Swapped in everywhere the
// mockup used emoji.
const wrap = (inner, viewBox = "0 0 24 24") =>
  `<svg viewBox="${viewBox}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;

export const ICONS = {
  home: wrap(`<path d="M4 11.5 12 4l8 7.5"/><path d="M6 10v9a1 1 0 0 0 1 1h4v-6h2v6h4a1 1 0 0 0 1-1v-9"/>`),
  calendar: wrap(`<rect x="3.5" y="5" width="17" height="16" rx="2.5"/><path d="M8 3v4M16 3v4M3.5 10h17"/>`),
  bell: wrap(`<path d="M6 10a6 6 0 0 1 12 0c0 4 1.5 5.5 1.5 5.5H4.5S6 14 6 10Z"/><path d="M10 19a2 2 0 0 0 4 0"/>`),
  gear: wrap(`<circle cx="12" cy="12" r="3.2"/><path d="M12 3v2.2M12 18.8V21M4.9 6.9l1.55 1.55M17.55 15.55l1.55 1.55M3 12h2.2M18.8 12H21M4.9 17.1l1.55-1.55M17.55 8.45l1.55-1.55"/>`),
  check: wrap(`<path d="M5 12.5 10 17l9-10"/>`),
  x: wrap(`<path d="M6 6l12 12M18 6 6 18"/>`),
  clock: wrap(`<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>`),
  warning: wrap(`<path d="M12 3.5 21.5 20h-19L12 3.5Z"/><path d="M12 10v4.2M12 17.3v.2"/>`),
  info: wrap(`<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 8v.2"/>`),
  user: wrap(`<circle cx="12" cy="8.5" r="3.5"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/>`),
  bellOutlineBig: wrap(`<path d="M6 10a6 6 0 0 1 12 0c0 4 1.5 5.5 1.5 5.5H4.5S6 14 6 10Z"/><path d="M10 19a2 2 0 0 0 4 0"/>`),
  chevronLeft: wrap(`<path d="M14.5 6 8.5 12l6 6"/>`),
  chevronRight: wrap(`<path d="M9.5 6l6 6-6 6"/>`),
  share: wrap(`<path d="M12 3v12"/><path d="M8 7l4-4 4 4"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/>`),
};

export function iconHtml(name) {
  return ICONS[name] || "";
}
export function icon(name) { return ICONS[name] || ""; }
