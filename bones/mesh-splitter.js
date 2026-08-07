// mesh-splitter.js
// Делит плоскую треугольную геометрию на несколько групп по заданным костям.
// Каждая кость — это набор из ОДНОГО ИЛИ НЕСКОЛЬКИХ ориентированных боксов (OBB).
// Так пользователь может «объединить» несколько кубов в одну логическую кость —
// при экспорте вся геометрия, попавшая в любой из этих кубов, уйдёт в один общий меш.
//
// Треугольник относится к кости, если хотя бы одна из его вершин попадает
// хотя бы в один из боксов этой кости. Приоритет — по порядку следования костей
// в массиве (первая подходящая кость забирает треугольник). Треугольники, не
// попавшие ни в одну кость, остаются в группе "main".
//
// Геометрия на входе — плоские массивы position/normal/uv (как из bedrock-parser),
// уже в мировых координатах сцены.

/**
 * @param {{positions:number[], normals:number[], uvs:number[]}} geom
 * @param {Array<{
 *   name:string,
 *   enabled:boolean,
 *   boxes: Array<{
 *     center:[number,number,number],
 *     halfSize:[number,number,number],
 *     invRotation: number[] // 3x3 матрица (row-major, 9 чисел) — инверсия поворота бокса
 *   }>
 * }>} bones
 * @returns {Array<{name:string, positions:number[], normals:number[], uvs:number[], triCount:number}>}
 */
export function splitGeometryByBones(geom, bones) {
  const { positions, normals, uvs } = geom;
  const triCount = positions.length / 9; // 3 verts * 3 floats per tri

  const buckets = new Map();
  buckets.set('main', emptyBucket());
  for (const b of bones) {
    if (b.enabled) buckets.set(b.name, emptyBucket());
  }

  const activeBones = bones.filter(b => b.enabled && b.boxes && b.boxes.length > 0);

  for (let t = 0; t < triCount; t++) {
    const base = t * 9;
    const uvBase = t * 6;

    let targetName = 'main';
    outer: for (const bone of activeBones) {
      for (const box of bone.boxes) {
        if (
          pointInOBB(positions[base + 0], positions[base + 1], positions[base + 2], box) ||
          pointInOBB(positions[base + 3], positions[base + 4], positions[base + 5], box) ||
          pointInOBB(positions[base + 6], positions[base + 7], positions[base + 8], box)
        ) {
          targetName = bone.name;
          break outer; // первая подходящая кость по приоритету забирает треугольник
        }
      }
    }

    const bucket = buckets.get(targetName);
    for (let i = 0; i < 9; i++) bucket.positions.push(positions[base + i]);
    for (let i = 0; i < 9; i++) bucket.normals.push(normals[base + i]);
    for (let i = 0; i < 6; i++) bucket.uvs.push(uvs[uvBase + i]);
    bucket.triCount++;
  }

  const result = [];
  for (const [name, bucket] of buckets.entries()) {
    result.push({ name, positions: bucket.positions, normals: bucket.normals, uvs: bucket.uvs, triCount: bucket.triCount });
  }
  return result;
}

/**
 * Проверяет, находится ли мировая точка (px,py,pz) внутри ориентированного бокса (OBB).
 * Переводит точку в локальное пространство куба (вычитает центр, применяет инверсию поворота)
 * и сравнивает с half-extents по каждой оси.
 */
function pointInOBB(px, py, pz, box) {
  const dx = px - box.center[0];
  const dy = py - box.center[1];
  const dz = pz - box.center[2];

  const m = box.invRotation;
  const lx = m[0] * dx + m[1] * dy + m[2] * dz;
  const ly = m[3] * dx + m[4] * dy + m[5] * dz;
  const lz = m[6] * dx + m[7] * dy + m[8] * dz;

  return (
    lx >= -box.halfSize[0] && lx <= box.halfSize[0] &&
    ly >= -box.halfSize[1] && ly <= box.halfSize[1] &&
    lz >= -box.halfSize[2] && lz <= box.halfSize[2]
  );
}

function emptyBucket() {
  return { positions: [], normals: [], uvs: [], triCount: 0 };
}
