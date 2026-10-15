/** Render the prepared court SVG and release every temporary resource. */
export async function exportPlaybookPng(svg: SVGSVGElement, name: string): Promise<void> {
  let image: HTMLImageElement | null = null;
  let svgUrl: string | null = null;
  let pngUrl: string | null = null;
  let downloadStarted = false;
  try {
    const serialized = new XMLSerializer().serializeToString(svg);
    image = new Image();
    svgUrl = URL.createObjectURL(new Blob([serialized], { type: "image/svg+xml" }));
    const source = image;
    await new Promise<void>((resolve, reject) => {
      source.onload = () => resolve();
      source.onerror = () => reject(new Error("PNG export could not render this diagram. Please try again."));
      source.src = svgUrl!;
    });
    const canvas = document.createElement("canvas");
    canvas.width = 1600;
    canvas.height = 1232;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("PNG export could not access the canvas. Please try again.");
    context.fillStyle = "#0d0f10";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#f3f1ec";
    context.font = "600 30px Inter, Arial, sans-serif";
    context.fillText(name || "ARC play", 48, 48);
    context.drawImage(source, 0, 80, canvas.width, 1152);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((value) => value ? resolve(value) : reject(new Error("PNG export could not create the image file. Please try again.")), "image/png");
    });
    pngUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.download = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "arc-play"}.png`;
    link.href = pngUrl;
    link.click();
    downloadStarted = true;
  } finally {
    if (image) { image.onload = null; image.onerror = null; }
    if (svgUrl) URL.revokeObjectURL(svgUrl);
    if (pngUrl) {
      const url = pngUrl;
      // Let the browser begin reading a successful download before releasing it.
      if (downloadStarted) window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      else URL.revokeObjectURL(url);
    }
  }
}
