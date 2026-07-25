// mesh-splitter.js
// Делит плоскую треугольную геометрию на несколько групп по заданным
// осевым боксам (кости). Каждый треугольник целиком относится к первой
// кости (по порядку), чей бокс пересекает центр треугольника.
// Треугольники, не попавшие ни в одну кость, остаются в группе "main".
//
// Геометрия на входе — плоские массивы position/normal/uv (как из bedrock-parser),
// уже в мировых координатах сцены (после применения object3d.matrixWorld).

/**
 * @param {{positions:number[], normals:number[], uvs:number[]}} geom
 * @param {Array<{name:string, enabled:boolean, min:[number,number,number], max:[number,number,number]}>} bones
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
      if (
        cx >= bone.min[0] && cx <= bone.max[0] &&
        cy >= bone.min[1] && cy <= bone.max[1] &&
        cz >= bone.min[2] && cz <= bone.max[2]
      ) {
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

function emptyBucket() {
  return { positions: [], normals: [], uvs: [], triCount: 0 };
}
