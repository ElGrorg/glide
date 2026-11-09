// Just enough of a DOM for the game modules to load under node (canvases for textures).
const ctx = new Proxy({}, { get: (_t, k) => (k === 'createLinearGradient' || k === 'createRadialGradient' ? () => ({ addColorStop() {} }) : k === 'getImageData' ? () => ({ data: new Uint8ClampedArray(4) }) : () => {}), set: () => true });
const el = () => ({ width: 0, height: 0, style: {}, getContext: () => ctx, addEventListener() {}, appendChild() {}, classList: { add() {}, remove() {} } });
(globalThis as Record<string, unknown>).document = { createElement: el, getElementById: () => el(), body: el() };
