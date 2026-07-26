// mesh-splitter.js
// Делит плоскую треугольную геометрию на несколько групп по заданным
// ориентированным боксам (кости, с учётом поворота). Каждый треугольник целиком
// относится к первой кости (по порядку), внутрь чьего OBB попадает его центр.
// Треугольники, не попавшие ни в одну кость, остаются в группе "main".
//
// Геометрия на входе — плоские массивы position/normal/uv (как из bedrock-parser),
// уже в мировых координатах сцены.

/**
 * @param {{positions:number[], normals:number[], uvs:number[]}} geom
 * @param {Array<{
 *   name:string,
 *   enabled:boolean,
 *   center:[number,number,number],
 *   halfSize:[number,number,number],
 *   invRotation: number[] // 3x3 матрица (row-major, 9 чисел) — инверсия поворота кости
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

  const activeBones = bones.filter(b => b.enabled);

  for (let t = 0; t < triCount; t++) {
    const base = t * 9;
    const uvBase = t * 6;

    const cx = (positions[base + 0] + positions[base + 3] + positions[base + 6]) / 3;
    const cy = (positions[base + 1] + positions[base + 4] + positions[base + 7]) / 3;
    const cz = (positions[base + 2] + positions[base + 5] + positions[base + 8]) / 3;

    let targetName = 'main';
    for (const bone of activeBones) {
      if (pointInOBB(cx, cy, cz, bone)) {
        targetName = bone.name;
        break; // первая кость по приоритету забирает треугольник
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
 * Проверяет, находится ли мировая точка (px,py,pz) внутри ориентированного бокса (OBB) кости.
 * Переводит точку в локальное пространство куба (вычитает центр, применяет инверсию поворота)
 * и сравнивает с half-extents по каждой оси.
 */
function pointInOBB(px, py, pz, bone) {
  const dx = px - bone.center[0];
  const dy = py - bone.center[1];
  const dz = pz - bone.center[2];

  const m = bone.invRotation;
  // Локальные координаты = invRotation * (p - center)
  const lx = m[0] * dx + m[1] * dy + m[2] * dz;
  const ly = m[3] * dx + m[4] * dy + m[5] * dz;
  const lz = m[6] * dx + m[7] * dy + m[8] * dz;

  return (
    lx >= -bone.halfSize[0] && lx <= bone.halfSize[0] &&
    ly >= -bone.halfSize[1] && ly <= bone.halfSize[1] &&
    lz >= -bone.halfSize[2] && lz <= bone.halfSize[2]
  );
}

function emptyBucket() {
  return { positions: [], normals: [], uvs: [], triCount: 0 };
}
