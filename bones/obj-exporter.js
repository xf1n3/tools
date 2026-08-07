// obj-exporter.js
// Строит текст .obj файла(ов) из набора групп { name, positions, normals, uvs }.
//
// Важно: геометрия на входе — "развёрнутая" (3 вершины на каждый треугольник,
// без переиспользования). Это раздувает .obj в 2-3 раза по сравнению с исходником,
// где одна вершина обычно используется несколькими треугольниками. Поэтому здесь
// делаем дедупликацию: одинаковые (position, normal, uv) сводятся к одному индексу.

const PRECISION = 5; // знаков после запятой — достаточно для игровых моделей, но заметно компактнее чем 6

/**
 * Строит один OBJ-файл со всеми группами через "g <name>" / "o <name>",
 * с общей (сквозной) дедупликацией вершин по всему файлу.
 * @param {Array<{name:string, positions:number[], normals:number[], uvs:number[]}>} groups
 */
export function buildSingleObj(groups) {
  let out = '# Exported by Bone Splitter\n# Groups: ' + groups.map(g => g.name).join(', ') + '\n\n';

  const vLines = [];
  const vtLines = [];
  const vnLines = [];
  const vertexIndex = new Map(); // key -> {v, vt, vn} (1-based индексы)
  let nextIndex = 1;

  const faceSections = [];

  for (const group of groups) {
    if (group.positions.length === 0) continue;
    const vertCount = group.positions.length / 3;
    const triCount = vertCount / 3;

    const faceLines = [];
    for (let t = 0; t < triCount; t++) {
      const idxs = [];
      for (let k = 0; k < 3; k++) {
        const i = t * 3 + k;
        const idx = getOrAddVertex(
          vertexIndex, vLines, vtLines, vnLines,
          group.positions[i * 3], group.positions[i * 3 + 1], group.positions[i * 3 + 2],
          group.normals[i * 3], group.normals[i * 3 + 1], group.normals[i * 3 + 2],
          group.uvs[i * 2], group.uvs[i * 2 + 1],
          () => nextIndex++
        );
        idxs.push(idx);
      }
      faceLines.push(`f ${idxs[0]}/${idxs[0]}/${idxs[0]} ${idxs[1]}/${idxs[1]}/${idxs[1]} ${idxs[2]}/${idxs[2]}/${idxs[2]}`);
    }

    faceSections.push({ name: sanitizeName(group.name), faceLines });
  }

  out += vLines.join('\n') + '\n';
  out += vtLines.join('\n') + '\n';
  out += vnLines.join('\n') + '\n';

  for (const section of faceSections) {
    out += `\no ${section.name}\ng ${section.name}\n`;
    out += section.faceLines.join('\n') + '\n';
  }

  return out;
}

/**
 * Строит отдельный OBJ-текст для одной группы (индексация всегда с 1, локальная),
 * с дедупликацией вершин внутри этой группы.
 */
export function buildGroupObj(group) {
  const vertCount = group.positions.length / 3;
  const triCount = vertCount / 3;
  let out = `# Exported by Bone Splitter\n# Mesh: ${group.name}\n\n`;
  out += `o ${sanitizeName(group.name)}\n`;

  const vLines = [];
  const vtLines = [];
  const vnLines = [];
  const vertexIndex = new Map();
  let nextIndex = 1;
  const faceLines = [];

  for (let t = 0; t < triCount; t++) {
    const idxs = [];
    for (let k = 0; k < 3; k++) {
      const i = t * 3 + k;
      const idx = getOrAddVertex(
        vertexIndex, vLines, vtLines, vnLines,
        group.positions[i * 3], group.positions[i * 3 + 1], group.positions[i * 3 + 2],
        group.normals[i * 3], group.normals[i * 3 + 1], group.normals[i * 3 + 2],
        group.uvs[i * 2], group.uvs[i * 2 + 1],
        () => nextIndex++
      );
      idxs.push(idx);
    }
    faceLines.push(`f ${idxs[0]}/${idxs[0]}/${idxs[0]} ${idxs[1]}/${idxs[1]}/${idxs[1]} ${idxs[2]}/${idxs[2]}/${idxs[2]}`);
  }

  out += vLines.join('\n') + '\n';
  out += vtLines.join('\n') + '\n';
  out += vnLines.join('\n') + '\n';
  out += faceLines.join('\n') + '\n';

  return out;
}

/**
 * Возвращает индекс вершины (1-based), переиспользуя уже существующую запись,
 * если такая комбинация position+normal+uv уже встречалась.
 */
function getOrAddVertex(vertexIndex, vLines, vtLines, vnLines, px, py, pz, nx, ny, nz, u, v, allocateIndex) {
  const key = `${fmt(px)}|${fmt(py)}|${fmt(pz)}|${fmt(nx)}|${fmt(ny)}|${fmt(nz)}|${fmt(u)}|${fmt(v)}`;
  const existing = vertexIndex.get(key);
  if (existing !== undefined) return existing;

  const idx = allocateIndex();
  vLines.push(`v ${fmt(px)} ${fmt(py)} ${fmt(pz)}`);
  vtLines.push(`vt ${fmt(u)} ${fmt(v)}`);
  vnLines.push(`vn ${fmt(nx)} ${fmt(ny)} ${fmt(nz)}`);
  vertexIndex.set(key, idx);
  return idx;
}

function fmt(n) {
  // toFixed возвращает строку без потери детерминизма (в отличие от Number(...).toFixed на округлённом числе)
  return Number(n.toFixed(PRECISION));
}

function sanitizeName(name) {
  return String(name).replace(/[^a-zA-Z0-9_\-]/g, '_');
}
