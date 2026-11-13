// 内联 SVG 图标集 —— 不引图标字体、不引外链。全部 16×16 视框，currentColor 描边。

const P = {
  providers:
    '<rect x="2" y="3" width="12" height="4.2" rx="1.2"/><rect x="2" y="8.8" width="12" height="4.2" rx="1.2"/>' +
    '<path d="M4.6 5.1h.01M4.6 10.9h.01" stroke-linecap="round"/>',
  map:
    '<path d="M2.5 5.2h8.2M8.2 2.6l2.6 2.6-2.6 2.6" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M13.5 10.8H5.3M7.8 8.2l-2.6 2.6 2.6 2.6" stroke-linecap="round" stroke-linejoin="round"/>',
  logs: '<path d="M3 4h10M3 8h10M3 12h6.5" stroke-linecap="round"/>',
  about:
    '<circle cx="8" cy="8" r="6"/><path d="M8 7.2v4M8 4.9h.01" stroke-linecap="round"/>',
  plus: '<path d="M8 3.2v9.6M3.2 8h9.6" stroke-linecap="round"/>',
  minus: '<path d="M3.2 8h9.6" stroke-linecap="round"/>',
  trash:
    '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.2h5.8l.6-8.2" stroke-linecap="round" stroke-linejoin="round"/>',
  eye:
    '<path d="M1.6 8S3.9 4 8 4s6.4 4 6.4 4-2.3 4-6.4 4S1.6 8 1.6 8Z" stroke-linejoin="round"/>' +
    '<circle cx="8" cy="8" r="1.9"/>',
  eyeOff:
    '<path d="M6.3 4.3A6.6 6.6 0 0 1 8 4c4.1 0 6.4 4 6.4 4a12 12 0 0 1-2.1 2.5M9.9 9.9A2.4 2.4 0 0 1 6.1 6.1"' +
    ' stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M2 2l12 12" stroke-linecap="round"/>',
  refresh:
    '<path d="M13 8a5 5 0 1 1-1.6-3.7" stroke-linecap="round"/>' +
    '<path d="M13.4 2.4v3.1h-3.1" stroke-linecap="round" stroke-linejoin="round"/>',
  search: '<circle cx="7.2" cy="7.2" r="4.2"/><path d="M10.3 10.3L13.4 13.4" stroke-linecap="round"/>',
  close: '<path d="M4 4l8 8M12 4l-8 8" stroke-linecap="round"/>',
  sun:
    '<circle cx="8" cy="8" r="3"/><path d="M8 1.6v1.6M8 12.8v1.6M1.6 8h1.6M12.8 8h1.6' +
    'M3.5 3.5l1.1 1.1M11.4 11.4l1.1 1.1M12.5 3.5l-1.1 1.1M4.6 11.4l-1.1 1.1" stroke-linecap="round"/>',
  moon: '<path d="M13 9.4A5.4 5.4 0 0 1 6.6 3 5.6 5.6 0 1 0 13 9.4Z" stroke-linejoin="round"/>',
  check: '<path d="M3.2 8.4l3 3 6.6-6.8" stroke-linecap="round" stroke-linejoin="round"/>',
  alert:
    '<path d="M8 2.4l5.6 9.8H2.4L8 2.4Z" stroke-linejoin="round"/>' +
    '<path d="M8 6.2v2.6M8 10.7h.01" stroke-linecap="round"/>',
  plug:
    '<path d="M6 2.4v3.2M10 2.4v3.2" stroke-linecap="round"/>' +
    '<path d="M4 5.6h8v2a4 4 0 0 1-4 4 4 4 0 0 1-4-4v-2Z" stroke-linejoin="round"/>' +
    '<path d="M8 11.6v2" stroke-linecap="round"/>',
  download:
    '<path d="M8 2.6v8M4.8 7.4L8 10.6l3.2-3.2" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M3 12.6v.6a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-.6" stroke-linecap="round"/>',
  key:
    '<circle cx="5.4" cy="10.6" r="2.6"/><path d="M7.4 8.6L12.4 3.6M10.4 5.6l1.6 1.6M11.9 4.1l1.4 1.4"' +
    ' stroke-linecap="round" stroke-linejoin="round"/>',
  link:
    '<path d="M6.6 9.4a2.8 2.8 0 0 0 4 0l1.6-1.6a2.8 2.8 0 0 0-4-4l-.7.7"' +
    ' stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M9.4 6.6a2.8 2.8 0 0 0-4 0L3.8 8.2a2.8 2.8 0 0 0 4 4l.7-.7"' +
    ' stroke-linecap="round" stroke-linejoin="round"/>',
  gem:
    '<path d="M5.4 2.6h5.2l2.8 3.4L8 13.4 2.6 6l2.8-3.4Z" stroke-linejoin="round"/>' +
    '<path d="M2.6 6h10.8M6.6 2.6L8 6l1.4-3.4" stroke-linejoin="round"/>',
  brain:
    '<path d="M6.4 2.6a2 2 0 0 0-2 2 2 2 0 0 0-1.2 3.6A2 2 0 0 0 4.4 12a2 2 0 0 0 3.6 1.2V2.9a2 2 0 0 0-1.6-.3Z"' +
    ' stroke-linejoin="round"/>' +
    '<path d="M9.6 2.6a2 2 0 0 1 2 2 2 2 0 0 1 1.2 3.6A2 2 0 0 1 11.6 12a2 2 0 0 1-3.6 1.2"' +
    ' stroke-linejoin="round"/>',
  chevron: '<path d="M4.6 6.4L8 9.8l3.4-3.4" stroke-linecap="round" stroke-linejoin="round"/>',
  upload:
    '<path d="M8 10.4V2.6M4.8 5.8L8 2.6l3.2 3.2" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M3 12.6v.6a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-.6" stroke-linecap="round"/>',
};

export function icon(name, size = 16, cls = '') {
  const body = P[name] || P.about;
  return (
    `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" aria-hidden="true"` +
    (cls ? ` class="${cls}"` : '') +
    ` stroke="currentColor" stroke-width="1.3">${body}</svg>`
  );
}

export function hasIcon(name) {
  return Object.prototype.hasOwnProperty.call(P, name);
}
