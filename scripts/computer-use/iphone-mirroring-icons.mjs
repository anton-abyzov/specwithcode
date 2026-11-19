// Finds a column of round icon buttons in a picture of the iPhone Mirroring
// window: Clock on iOS 27 shows its four tabs as icons only, in a pill at the
// lower right, so no text names them.

/** How strongly neighbouring pixels must differ to be an icon's edge (luminance, 0-255). */
const EDGE = 60;

/**
 * The centres of a column of `count` evenly spaced icons in the lower right of
 * an RGB(A) picture, top to bottom, in its own pixels; undefined when there is
 * no such column or more than one. Sizes are fractions of the picture, so the
 * screenshot's scale does not matter. Every icon-sized mark it saw goes into
 * `marks`, for a log that shows why no column was found.
 */
export function findIconColumn({ data, width, height, channels }, count = 4, marks = []) {
  if (width < 40 || height < 40) return undefined;
  const lum = new Float32Array(width * height);
  for (let index = 0; index < width * height; index++) {
    const at = index * channels;
    lum[index] = 0.299 * data[at] + 0.587 * data[at + 1] + 0.114 * data[at + 2];
  }
  // Only the lower right holds the pill: the right quarter, below the middle.
  const x0 = Math.floor(width * 0.75);
  const y0 = Math.floor(height * 0.45);
  const w = width - x0;
  const h = height - y0;
  const edge = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const at = (y0 + y) * width + x0 + x;
      const across = Math.abs(lum[at + 1] - lum[at - 1]);
      const down = Math.abs(lum[at + width] - lum[at - width]);
      if (Math.max(across, down) > EDGE) edge[y * w + x] = 1;
    }
  }
  // Joins the strokes of one icon (an alarm clock's bells) without joining two icons.
  const reach = Math.max(1, Math.round(width * 0.006));
  const grown = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (edge[y * w + x] === 0) continue;
      for (let dy = -reach; dy <= reach; dy++) {
        for (let dx = -reach; dx <= reach; dx++) {
          const yy = y + dy;
          const xx = x + dx;
          if (yy >= 0 && yy < h && xx >= 0 && xx < w) grown[yy * w + xx] = 1;
        }
      }
    }
  }
  // Connected marks, each as a box.
  const blobs = [];
  const stack = [];
  for (let start = 0; start < w * h; start++) {
    if (grown[start] !== 1) continue;
    grown[start] = 2;
    stack.push(start);
    let left = w;
    let right = -1;
    let top = h;
    let bottom = -1;
    while (stack.length > 0) {
      const at = stack.pop();
      const x = at % w;
      const y = (at - x) / w;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
      for (const next of [at - 1, at + 1, at - w, at + w]) {
        if (next < 0 || next >= w * h) continue;
        if ((next === at - 1 || next === at + 1) && Math.floor(next / w) !== y) continue;
        if (grown[next] === 1) {
          grown[next] = 2;
          stack.push(next);
        }
      }
    }
    // An icon the search area cuts would sit off centre: leave it out.
    if (left === 0 || top === 0 || right === w - 1 || bottom === h - 1) continue;
    // Back to the icon's own size: the growing added `reach` on each side.
    const bw = right - left + 1 - 2 * reach;
    const bh = bottom - top + 1 - 2 * reach;
    blobs.push({ x: x0 + (left + right) / 2, y: y0 + (top + bottom) / 2, width: bw, height: bh });
  }
  // Icon sized and roughly square.
  const icons = blobs.filter(
    (blob) =>
      blob.width >= width * 0.025 &&
      blob.width <= width * 0.12 &&
      blob.height >= width * 0.025 &&
      blob.height <= width * 0.12 &&
      blob.width / blob.height >= 0.5 &&
      blob.width / blob.height <= 2,
  );
  for (const icon of icons) marks.push({ x: Math.round(icon.x), y: Math.round(icon.y) });
  const columns = [];
  for (const first of icons) {
    const column = icons
      .filter((blob) => Math.abs(blob.x - first.x) <= width * 0.03)
      .sort((a, b) => a.y - b.y);
    if (column[0] !== first) continue;
    // Runs of `count` evenly spaced icons; a longer run is a list, not the pill.
    const gaps = column.slice(1).map((blob, index) => blob.y - column[index].y);
    const even = (list) => {
      const mean = list.reduce((sum, gap) => sum + gap, 0) / list.length;
      return (
        mean >= height * 0.04 &&
        mean <= height * 0.12 &&
        list.every((gap) => Math.abs(gap - mean) <= mean * 0.15)
      );
    };
    for (let index = 0; index + count <= column.length; index++) {
      const run = gaps.slice(index, index + count - 1);
      if (!even(run)) continue;
      const before = index > 0 && even([...run, gaps[index - 1]]);
      const after = index + count - 1 < gaps.length && even([...run, gaps[index + count - 1]]);
      if (!before && !after) columns.push(column.slice(index, index + count));
    }
  }
  if (columns.length !== 1) return undefined;
  return columns[0].map((blob) => ({ x: Math.round(blob.x), y: Math.round(blob.y) }));
}
