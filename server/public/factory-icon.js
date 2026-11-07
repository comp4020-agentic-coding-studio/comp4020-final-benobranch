// @ts-check
// Factory marker icon (ANU-049), a dependency-free module (same convention
// as data-center-visual.js/unit-icon.js/base-icon.js) so the icon path/size
// constants can be imported without a DOM. factory-visual.js stays the pure
// FactoryState -> FactoryVisual transform (ANU-013's file-layout
// convention); this sibling module holds the static asset path the same way
// unit-icon.js/base-icon.js sit alongside unit-visual.js/renderBases rather
// than inside them.
//
// No existing glyph in the craftpix Skillicon #35 pack (server/public/icons/,
// server/public/icons/skills/ — license in the asset pack's own
// License.txt, see issues/ANU-041.md for the outstanding crediting work)
// reads as "factory/production" on its own: better-fabs.png is a bracket
// motif, lean-production.png a diagonal arrow, the chassis/advanced-* icons
// are circuitry/chevron glyphs for units, and data-uplink/rapid-capture/
// researching/salvage-training are all abstract arrow-and-dot shapes. So
// this icon is a new 32x32 PNG hand-built to match the pack's existing
// palette/style exactly (same P-mode PNG with the pack's five-color
// palette — white glyph fill, pink main outline, mint 1px "glitch" offset
// echo, sparse blue accent dots, index 5 as the transparency key, same as
// e.g. better-fabs.png), rather than a straight reuse of an unrelated
// glyph. It depicts a building with twin chimneys + smoke puffs, in the
// same angular pixel-art line weight as the rest of the pack.
export const FACTORY_ICON = "icons/factory.png";

// Icon display size (in map units) — matches the pre-ANU-049 hardcoded
// factory marker size (`renderFactories`'s backdrop rect was 280x280).
export const FACTORY_MARKER_SIZE = 280;
