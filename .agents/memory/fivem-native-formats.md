---
name: FiveM native formats
description: Boundaries between resource packaging and true GTA binary conversion in Forge Studio.
---

Forge Studio can preserve and package native GTA resources such as YFT, YTD, YDR, YDD, and YBN, but its Three.js viewer does not decode or produce those RAGE binaries. Keep packaging, preview, editing, and conversion claims separate. Do not claim native editing/export until a compatible GTA format decoder and encoder are actually integrated.

**Why:** FiveM vehicle resources use specialized GTA asset formats; FiveForge's vehicle editor advertises editing and returning native model and texture files, while the current Forge Studio model pipeline handles standard 3D formats.

**How to apply:** Any future native-format work should test round-trip fidelity against representative resources and preserve unknown files/metadata. A ZIP containing unchanged YFT/YTD files is packaging support, not a native-format editor.
