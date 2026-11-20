# ScanLab

Browser-based correction for scanned film strips plus 8×10 contact sheets. All processing runs locally in the browser, so images are never uploaded.

**Open:** https://djbetterly.github.io/scanlab/

## What it does
1. **B&W strips:** sets black and white points per frame, clipping 0.02% of the shadows and 0.02% of the highlights, measured inside each frame so the film rebate is ignored. The output is pure grayscale (saturation 0).
2. **Colour strips** (detected automatically): per-channel levels at a 0.1% clip, then highlight white balance on the backdrop, then a gentle midtone grey balance. This removes the cast from faded transparencies.
3. **Contact sheet** for each folder: an 8×10 in print at 300 dpi (2400×3000 px), on black, with a label.

Outputs follow the folder layout: `<Folder>/<strip>_corrected.jpg` and `<Folder>/<Folder>_ContactSheet.jpg`. You can download them as a .zip, or in Chrome/Edge save them straight back into the scan folder.

## Hermes reporting
If you enter the Hermes URL and API key (both are stored only in this browser), each run sends a short job report: strip and frame counts and the correction values. Hermes logs the report and sends a WhatsApp notification. The scanning computer has to be on the tailnet for this.

The algorithm in `core.js` mirrors `contact_sheet.py` in the Hermes `film-scan-processing` skill.
