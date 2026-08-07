// bedrock-parser.js
// Парсит Bedrock Edition geometry JSON (format_version 1.12.0 / 1.16.0 / 1.21.0 и т.п.)
// и достаёт из него треугольную геометрию (обычно вшитую как polyMesh внутри bone,
// как это делают конвертеры .obj -> bedrock geometry).
//
// Возвращает список "источников" геометрии (по одному на каждый bone/polyMesh),
// каждый как { name, positions: Float32Array, normals, uvs, indices }.

/**
 * @param {object} json — распарсенный bedrock geometry json
 * @returns {{ formatVersion: string, sourceName: string, groups: Array<{name:string, positions:number[], normals:number[], uvs:number[]}> }}
 */
export function parseBedrockGeometry(json) {
  if (!json || typeof json !== 'object') {
    throw new Error('Файл не является валидным JSON-объектом');
  }

  const formatVersion = json.format_version || 'unknown';
  const geoArray = json['minecraft:geometry'];
  if (!Array.isArray(geoArray) || geoArray.length === 0) {
    throw new Error('В файле нет ключа "minecraft:geometry" — это не Bedrock geometry JSON');
  }

  const geo = geoArray[0];
  const description = geo.description || {};
  const sourceName = description.identifier || 'geometry';
  const bones = geo.bones || [];

  if (bones.length === 0) {
    throw new Error('В geometry нет "bones" — нечего импортировать');
  }

  const groups = [];

  for (const bone of bones) {
    const boneName = bone.name || 'bone';
    const pivot = bone.pivot || [0, 0, 0];

    // Вариант 1: polyMesh / poly_mesh (это то, что обычно получается при конвертации
    // .obj -> bedrock geometry; Blockbench + плагины типа Meshy пишут "poly_mesh" с подчёркиванием,
    // тогда как в части документации/примеров используется camelCase "polyMesh" — поддерживаем оба).
    const polyMeshData = bone.polyMesh || bone.poly_mesh;
    if (polyMeshData) {
      const g = polyMeshToGroup(polyMeshData, boneName, pivot);
      if (g) groups.push(g);
      continue;
    }

    // Вариант 2: cubes (обычный bedrock рига-формат) — конвертируем кубы в треугольники,
    // чтобы с ними тоже можно было работать в 3D и резать.
    if (Array.isArray(bone.cubes) && bone.cubes.length > 0) {
      const g = cubesToGroup(bone.cubes, boneName, pivot);
      if (g) groups.push(g);
    }
  }

  if (groups.length === 0) {
    throw new Error('Не удалось найти геометрию (ни polyMesh/poly_mesh, ни cubes) ни в одной кости');
  }

  return { formatVersion, sourceName, groups, rawJson: json };
}

/**
 * Конвертирует bedrock polyMesh (normalized_uvs, positions, normals, uvs, polys)
 * в плоские массивы для three.js BufferGeometry (треугольники — poly с 3 индексами,
 * quad — раскладываем на 2 треугольника).
 */
function polyMeshToGroup(pm, name, pivot) {
  const positionsSrc = pm.positions || [];
  const normalsSrc = pm.normals || [];
  const uvsSrc = pm.uvs || [];
  const polys = pm.polys || [];

  const positions = [];
  const normals = [];
  const uvs = [];

  function pushVertex(vref) {
    // vref формат bedrock: [posIndex, normalIndex, uvIndex]
    const pi = vref[0];
    const ni = vref.length > 1 ? vref[1] : undefined;
    const ui = vref.length > 2 ? vref[2] : undefined;

    const p = positionsSrc[pi] || [0, 0, 0];
    positions.push(p[0], p[1], p[2]);

    if (ni !== undefined && normalsSrc[ni]) {
      const n = normalsSrc[ni];
      normals.push(n[0], n[1], n[2]);
    } else {
      normals.push(0, 1, 0);
    }

    if (ui !== undefined && uvsSrc[ui]) {
      const uv = uvsSrc[ui];
      uvs.push(uv[0], uv[1]);
    } else {
      uvs.push(0, 0);
    }
  }

  for (const poly of polys) {
    if (!Array.isArray(poly)) continue;
    if (poly.length === 3) {
      pushVertex(poly[0]);
      pushVertex(poly[1]);
      pushVertex(poly[2]);
    } else if (poly.length === 4) {
      // quad -> 2 triangles (0,1,2) (0,2,3)
      pushVertex(poly[0]);
      pushVertex(poly[1]);
      pushVertex(poly[2]);

      pushVertex(poly[0]);
      pushVertex(poly[2]);
      pushVertex(poly[3]);
    } else if (poly.length > 4) {
      // fan triangulation на всякий случай
      for (let i = 1; i < poly.length - 1; i++) {
        pushVertex(poly[0]);
        pushVertex(poly[i]);
        pushVertex(poly[i + 1]);
      }
    }
  }

  if (positions.length === 0) return null;

  return { name, positions, normals, uvs, pivot, kind: 'polymesh' };
}

/**
 * Конвертирует cubes-формат bone в треугольную геометрию (простые боксы),
 * чтобы такую геометрию тоже можно было отобразить и резать по костям.
 */
function cubesToGroup(cubes, name, pivot) {
  const positions = [];
  const normals = [];
  const uvs = [];

  for (const cube of cubes) {
    const origin = cube.origin || [0, 0, 0];
    const size = cube.size || [0, 0, 0];
    const inflate = cube.inflate || 0;

    const x0 = origin[0] - inflate;
    const y0 = origin[1] - inflate;
    const z0 = origin[2] - inflate;
    const x1 = origin[0] + size[0] + inflate;
    const y1 = origin[1] + size[1] + inflate;
    const z1 = origin[2] + size[2] + inflate;

    addBox(positions, normals, uvs, x0, y0, z0, x1, y1, z1);
  }

  if (positions.length === 0) return null;
  return { name, positions, normals, uvs, pivot, kind: 'cubes' };
}

function addBox(positions, normals, uvs, x0, y0, z0, x1, y1, z1) {
  // 6 граней, каждая — 2 треугольника, с корректными нормалями
  const faces = [
    // +X
    { n: [1, 0, 0], v: [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]] },
    // -X
    { n: [-1, 0, 0], v: [[x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [x0, y0, z0]] },
    // +Y
    { n: [0, 1, 0], v: [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]] },
    // -Y
    { n: [0, -1, 0], v: [[x0, y0, z1], [x0, y0, z0], [x1, y0, z0], [x1, y0, z1]] },
    // +Z
    { n: [0, 0, 1], v: [[x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [x0, y0, z1]] },
    // -Z
    { n: [0, 0, -1], v: [[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]] },
  ];

  const uvQuad = [[0, 0], [0, 1], [1, 1], [1, 0]];

  for (const f of faces) {
    const [a, b, c, d] = f.v;
    // triangle 1: a b c
    pushTri(positions, normals, uvs, f.n, [a, b, c], [uvQuad[0], uvQuad[1], uvQuad[2]]);
    // triangle 2: a c d
    pushTri(positions, normals, uvs, f.n, [a, c, d], [uvQuad[0], uvQuad[2], uvQuad[3]]);
  }
}

function pushTri(positions, normals, uvs, n, verts, uvpair) {
  for (let i = 0; i < 3; i++) {
    positions.push(verts[i][0], verts[i][1], verts[i][2]);
    normals.push(n[0], n[1], n[2]);
    uvs.push(uvpair[i][0], uvpair[i][1]);
  }
}
