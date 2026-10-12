from __future__ import annotations

import base64
import io
import json
import sys
from typing import Any

from PIL import Image
from fivefury.yft import Yft
from fivefury.ytd import Texture, TextureFormat, read_ytd

MAX_FILE_BYTES = 250 * 1024 * 1024
MAX_PREVIEW_PIXELS = 40_000_000


def decode_base64(value: Any, label: str) -> bytes:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{label} is missing.")
    if len(value) > (MAX_FILE_BYTES * 4 // 3) + 16:
        raise ValueError(f"{label} is larger than 250 MB.")
    try:
        decoded = base64.b64decode(value, validate=True)
    except Exception as error:
        raise ValueError(f"{label} is not valid base64 data.") from error
    if len(decoded) > MAX_FILE_BYTES:
        raise ValueError(f"{label} is larger than 250 MB.")
    return decoded


def image_from_texture(texture: Texture) -> Image.Image:
    image = Image.open(io.BytesIO(texture.to_dds_bytes()))
    image.load()
    return image.convert("RGBA")


def encode_png(image: Image.Image) -> str:
    output = io.BytesIO()
    image.save(output, format="PNG", optimize=True)
    return base64.b64encode(output.getvalue()).decode("ascii")


def ytd_textures(data: bytes) -> tuple[Any, list[dict[str, Any]]]:
    ytd = read_ytd(data)
    textures: list[dict[str, Any]] = []
    total_pixels = 0
    for texture in ytd.textures:
        item: dict[str, Any] = {
            "name": texture.name,
            "width": texture.width,
            "height": texture.height,
            "format": texture.format_name,
            "mipCount": texture.mip_count,
            "previewBase64": None,
            "previewError": None,
        }
        total_pixels += max(texture.width, 0) * max(texture.height, 0)
        if total_pixels > MAX_PREVIEW_PIXELS:
            item["previewError"] = "This dictionary contains too many pixels to preview at once."
        else:
            try:
                item["previewBase64"] = encode_png(image_from_texture(texture))
            except Exception:
                item["previewError"] = "This GTA texture format can be listed but not decoded by the current image preview."
        textures.append(item)
    return ytd, textures


def decode_ytd(payload: dict[str, Any]) -> dict[str, Any]:
    data = decode_base64(payload.get("dataBase64"), "YTD file")
    _, textures = ytd_textures(data)
    return {"fileName": str(payload.get("fileName") or "textures.ytd"), "textures": textures}


def replace_ytd(payload: dict[str, Any]) -> dict[str, Any]:
    data = decode_base64(payload.get("dataBase64"), "YTD file")
    image_data = decode_base64(payload.get("imageBase64"), "Replacement image")
    texture_name = str(payload.get("textureName") or "").strip()
    if not texture_name or len(texture_name) > 255:
        raise ValueError("Choose a texture from this dictionary.")

    ytd = read_ytd(data)
    index = next((i for i, item in enumerate(ytd.textures) if item.name.casefold() == texture_name.casefold()), None)
    if index is None:
        raise ValueError("That texture is no longer present in this dictionary. Reload the preview and try again.")

    with Image.open(io.BytesIO(image_data)) as source:
        image = source.convert("RGBA")
        width, height = image.size
        if width < 1 or height < 1 or width > 16384 or height > 16384:
            raise ValueError("Replacement images must be between 1 and 16,384 pixels per side.")
        if width * height > MAX_PREVIEW_PIXELS:
            raise ValueError("Replacement image exceeds the 80-million-pixel safety limit.")
    previous = ytd.textures[index]
    mip_levels = [image]
    while mip_levels[-1].size != (1, 1):
        current = mip_levels[-1]
        mip_levels.append(current.resize((max(1, current.width // 2), max(1, current.height // 2)), Image.Resampling.LANCZOS))
    mip_data = b"".join(level.tobytes("raw", "BGRA") for level in mip_levels)
    replacement = Texture.from_raw(
        mip_data,
        width,
        height,
        TextureFormat.A8R8G8B8,
        len(mip_levels),
        name=previous.name,
        usage=previous.usage,
        usage_flags=previous.usage_flags,
    )
    ytd.textures[index] = replacement
    rebuilt = ytd.to_bytes()
    if len(rebuilt) > MAX_FILE_BYTES:
        raise ValueError("The rebuilt YTD exceeds the 250 MB safety limit.")
    return {
        "fileName": str(payload.get("fileName") or "textures.ytd"),
        "dataBase64": base64.b64encode(rebuilt).decode("ascii"),
        "texture": {
            "name": replacement.name,
            "width": replacement.width,
            "height": replacement.height,
            "format": replacement.format_name,
            "mipCount": replacement.mip_count,
        },
    }


def vector_rows(items: Any) -> list[list[float]]:
    rows: list[list[float]] = []
    for item in items or []:
        if hasattr(item, "x"):
            rows.append([float(item.x), float(item.y), float(getattr(item, "z", 0.0))])
        else:
            rows.append([float(component) for component in item])
    return rows


def preview_yft(payload: dict[str, Any]) -> dict[str, Any]:
    model_data = decode_base64(payload.get("modelBase64"), "YFT file")
    dictionaries = payload.get("textureDictionaries") or []
    if not isinstance(dictionaries, list) or len(dictionaries) > 24:
        raise ValueError("Choose up to 24 associated YTD dictionaries.")

    import numpy as np
    import trimesh

    texture_images: dict[str, Image.Image] = {}
    total_pixels = 0
    for dictionary in dictionaries:
        if not isinstance(dictionary, dict):
            continue
        raw = decode_base64(dictionary.get("dataBase64"), "YTD file")
        ytd = read_ytd(raw)
        for texture in ytd.textures:
            total_pixels += max(texture.width, 0) * max(texture.height, 0)
            if total_pixels > MAX_PREVIEW_PIXELS:
                break
            try:
                texture_images[texture.name.casefold()] = image_from_texture(texture)
            except Exception:
                continue
        if total_pixels > MAX_PREVIEW_PIXELS:
            break

    asset = Yft.from_bytes(model_data, path=str(payload.get("fileName") or "vehicle.yft"))
    try:
        meshes = asset.meshes(lod="high")
    except (KeyError, ValueError):
        meshes = []
    if not meshes:
        meshes = asset.meshes()
    if not meshes:
        raise ValueError("This YFT was read, but it contains no render meshes for the preview.")
    if len(meshes) > 600:
        raise ValueError("This YFT contains too many meshes to preview safely.")

    scene = trimesh.Scene()
    used_textures: set[str] = set()
    skipped = 0
    for index, source in enumerate(meshes):
        positions = vector_rows(source.positions)
        indices = [int(value) for value in source.indices]
        if len(positions) < 3 or len(indices) < 3:
            skipped += 1
            continue
        indices = indices[: len(indices) - (len(indices) % 3)]
        if not indices or min(indices) < 0 or max(indices) >= len(positions):
            skipped += 1
            continue

        mesh = trimesh.Trimesh(
            vertices=np.asarray([row[:3] for row in positions], dtype=np.float32),
            faces=np.asarray(indices, dtype=np.uint32).reshape((-1, 3)),
            process=False,
        )
        normals = vector_rows(source.normals)
        if len(normals) == len(positions):
            mesh.vertex_normals = np.asarray([row[:3] for row in normals], dtype=np.float32)

        source_material = source.material
        material_name = getattr(source_material, "name", "") or f"Material {index + 1}"
        texture_name = None
        if source_material is not None:
            for slot in ("DiffuseSampler", "DiffuseSampler2", "BaseColorSampler", "AlbedoSampler"):
                reference = source_material.get_texture(slot)
                if reference is not None and reference.name:
                    texture_name = reference.name
                    break
            if not texture_name and source_material.textures:
                texture_name = source_material.textures[0].name
        image = texture_images.get(texture_name.casefold()) if texture_name else None
        uv_channels = source.texcoords or []
        if uv_channels and len(uv_channels[0]) == len(positions) and image is not None:
            uv = np.asarray([[float(point.x), float(point.y)] for point in uv_channels[0]], dtype=np.float32)
            material = trimesh.visual.material.PBRMaterial(
                name=material_name,
                baseColorTexture=image,
                baseColorFactor=[255, 255, 255, 255],
            )
            mesh.visual = trimesh.visual.TextureVisuals(uv=uv, material=material)
            used_textures.add(texture_name or "")
        else:
            mesh.visual = trimesh.visual.ColorVisuals(
                mesh=mesh,
                vertex_colors=np.tile(np.array([164, 164, 160, 255], dtype=np.uint8), (len(positions), 1)),
            )

        name = getattr(source, "name", "") or f"vehicle_mesh_{index + 1}"
        scene.add_geometry(mesh, geom_name=f"{name}_{index}", node_name=f"{name}_{index}")

    if not scene.geometry:
        raise ValueError("No usable render meshes were found in this YFT.")
    glb = scene.export(file_type="glb")
    if not isinstance(glb, bytes):
        raise ValueError("Could not generate a preview model from this YFT.")
    return {
        "fileName": str(payload.get("fileName") or "vehicle.yft"),
        "modelBase64": base64.b64encode(glb).decode("ascii"),
        "meshCount": len(scene.geometry),
        "skippedMeshCount": skipped,
        "textureCount": len(used_textures),
        "usedTextures": sorted(used_textures),
    }


def main() -> None:
    try:
        payload = json.load(sys.stdin)
        if not isinstance(payload, dict):
            raise ValueError("Request body must be an object.")
        operation = sys.argv[1] if len(sys.argv) > 1 else ""
        if operation == "decode-ytd":
            result = decode_ytd(payload)
        elif operation == "replace-ytd":
            result = replace_ytd(payload)
        elif operation == "preview-yft":
            result = preview_yft(payload)
        else:
            raise ValueError("Unknown native asset operation.")
        sys.stdout.write(json.dumps(result, separators=(",", ":")))
    except Exception as error:
        sys.stderr.write(f"{type(error).__name__}: {error}\n")
        sys.stdout.write(json.dumps({"error": str(error)}, separators=(",", ":")))
        sys.exit(1)


if __name__ == "__main__":
    main()
