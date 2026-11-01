let ready: Promise<void> | undefined;
export function loadEditFont() {
  return (ready ??= (async () => {
    const font = new FontFace(
      "JumperCaption",
      `url(${import.meta.env.BASE_URL}jumper/fonts/RobotoMono.ttf)`,
      { weight: "100 700" },
    );
    await font.load();
    const fonts =
      "document" in globalThis
        ? document.fonts
        : (self as unknown as { fonts: FontFaceSet }).fonts;
    fonts.add(font);
  })().catch((error) => {
    ready = undefined;
    throw error;
  }));
}
