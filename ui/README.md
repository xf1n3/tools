# MCBE UI Studio v3

Browser-based Bedrock JSON UI editor and live preview.

## Start in GitHub Codespaces

```bash
npm install
npm run dev
```

Open the forwarded Vite port on your iPhone.

## Main workflow

1. **Load ZIP** — select your complete resource pack directly in the website.
2. Or **Load folder** — select an extracted pack directory.
3. The left side becomes a file tree for the whole pack.
4. Open any `.json` / `.jsonc` UI file.
5. Edit it in the middle editor; the preview updates automatically.
6. **Textures** shows the pack's image files.
7. Texture references such as `textures/ui/hitmarker` resolve to the real uploaded texture.
8. **Export pack** creates a new ZIP with your edited JSON and the rest of the pack.

The pack stays in browser memory for the current page; you do not need to put it in the GitHub repository.

## Included now

- Whole resource-pack ZIP/folder upload in the website
- File tree + search
- Multiple JSON tabs
- Live JSON parsing
- Format/save-in-memory controls
- Texture browser
- Real uploaded resource-pack textures
- Recursive `@namespace.control` references
- Panels/images/labels/custom approximations
- Anchors, offsets, sizes, layers
- Live title/actionbar/health/hunger/armor simulation
- iPhone/tablet/desktop preview
- Export edited resource pack as ZIP

This is a browser implementation, not Minecraft's native renderer. Bedrock has many native bindings, expressions, animations and custom controls that need to be implemented individually for pixel-perfect parity.
