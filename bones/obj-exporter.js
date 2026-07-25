// obj-exporter.js
// Строит текст .obj файла(ов) из набора групп { name, positions, normals, uvs }.

/**
 * Строит один OBJ-файл со всеми группами через "g <name>" / "o <name>".
 * @param {Array<{name:string, positions:number[], normals:number[], uvs:number[]}>} groups
 */
export function buildSingleObj(groups) {
  let out = '# Exported by Bone Splitter\n# Groups: ' + groups.map(g => g.name).join(', ') + '\n\n';
  let vOffset = 0;

  for (const group of groups) {
    if (group.positions.length === 0) continue;
    const vertCount = group.positions.length / 3;

    out += `o ${sanitizeName(group.name)}\n`;
    out += `g ${sanitizeName(group.name)}\n`;

    for (let i = 0; i < vertCount; i++) {
      out += `v ${fmt(group.positions[i * 3])} ${fmt(group.positions[i * 3 + 1])} ${fmt(group.positions[i * 3 + 2])}\n`;
    }
    for (let i = 0; i < vertCount; i++) {
      out += `vt ${fmt(group.uvs[i * 2])} ${fmt(group.uvs[i * 2 + 1])}\n`;
    }
    for (let i = 0; i < vertCount; i++) {
      out += `vn ${fmt(group.normals[i * 3])} ${fmt(group.normals[i * 3 + 1])} ${fmt(group.normals[i * 3 + 2])}\n`;
    }

    const triCount = vertCount / 3;
    for (let t = 0; t < triCount; t++) {
      const a = vOffset + t * 3 + 1;
      const b = vOffset + t * 3 + 2;
      const c = vOffset + t * 3 + 3;
      out += `f ${a}/${a}/${a} ${b}/${b}/${b} ${c}/${c}/${c}\n`;
    }

    vOffset += vertCount;
    out += '\n';
  }

  return out;
}

/**
 * Строит отдельный OBJ-текст для одной группы (индексация всегда с 1, локальная).
 */
export function buildGroupObj(group) {
  const vertCount = group.positions.length / 3;
  let out = `# Exported by Bone Splitter\n# Mesh: ${group.name}\n\n`;
  out += `o ${sanitizeName(group.name)}\n`;

  for (let i = 0; i < vertCount; i++) {
    out += `v ${fmt(group.positions[i * 3])} ${fmt(group.positions[i * 3 + 1])} ${fmt(group.positions[i * 3 + 2])}\n`;
  }
  for (let i = 0; i < vertCount; i++) {
    out += `vt ${fmt(group.uvs[i * 2])} ${fmt(group.uvs[i * 2 + 1])}\n`;
  }
  for (let i = 0; i < vertCount; i++) {
    out += `vn ${fmt(group.normals[i * 3])} ${fmt(group.normals[i * 3 + 1])} ${fmt(group.normals[i * 3 + 2])}\n`;
  }

  const triCount = vertCount / 3;
  for (let t = 0; t < triCount; t++) {
    const a = t * 3 + 1;
    const b = t * 3 + 2;
    const c = t * 3 + 3;
    out += `f ${a}/${a}/${a} ${b}/${b}/${b} ${c}/${c}/${c}\n`;
  }

  return out;
}

function fmt(n) {
  return Number(n.toFixed(6));
}

function sanitizeName(name) {
  return String(name).replace(/[^a-zA-Z0-9_\-]/g, '_');
}
