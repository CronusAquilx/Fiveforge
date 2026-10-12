from __future__ import annotations

import base64
import io
import json
import re
import sys
from typing import Any

from PIL import Image
from fivefury.yft import Yft
from fivefury.ytd import Texture, TextureFormat, read_ytd

MAX_FILE_BYTES = 250 * 1024 * 1024
MAX_PREVIEW_PIXELS = 40_000_000


def texture_key(value: str) -> str:
    leaf = value.replace("\\", "/").rsplit("/", 1)[-1].strip().casefold()
    leaf = re.sub(r"\.(dds|png|jpe?g|webp|bmp|tga)$", "", leaf)
    return re.sub(r"[^a-z0-9]", "", leaf)


def texture_reference_name(reference: Any) -> str:
    if isinstance(reference, str):
        return reference.strip()
    name = getattr(reference, "name", "")
    if name:
        return str(name).strip()
    if isinstance(reference, dict):
        return str(reference.get("name") or reference.get("texture") or "").strip()
    return ""


def display_mesh_name(source_name: str, material_name: str, index: int, duplicates: dict[str, int]) -> str:
    generic = re.compile(r"^(?:mesh|object|geometry|primitive|shape)(?:[._\s-]*\d+)?$", re.IGNORECASE)
    name = source_name.strip()
    if not name or generic.fullmatch(name):
        name = material_name.strip()
    if not name or generic.fullmatch(name) or name.casefold() in {"default", "material", "none"}:
        name = f"Vehicle part {index + 1:02d}"
    else:
        key = re.sub(r"[^a-z0-9]", "", name.casefold())
        engine = re.fullmatch(r"eng(?:ine)?([1-9])", key)
        wheel = re.fullmatch(r"wheel(?:mesh)?(lf|rf|lr|rr)(?:l([12])|ng)?", key)
        hub = re.fullmatch(r"hub(lf|rf|lr|rr)", key)
        door = re.fullmatch(r"door(dside|pside)(f|r)", key)
        if key == "bodyshell":
            name = "Body Shell"
        elif key == "steeringwheel":
            name = "Steering Wheel"
        elif engine:
            name = f"Engine {engine.group(1)}"
        elif wheel:
            suffix = f" L{wheel.group(2)}" if wheel.group(2) else (" NG" if key.endswith("ng") else "")
            name = f"Wheel {wheel.group(1).upper()}{suffix}"
        elif hub:
            name = f"Hub {hub.group(1).upper()}"
        elif door:
            side = "Driver" if door.group(1) == "dside" else "Passenger"
            position = "Front" if door.group(2) == "f" else "Rear"
            name = f"{side} Door {position}"
        else:
            parts = re.sub(r"[_-]+", " ", name).strip().split()
            abbreviations = {"lf": "LF", "rf": "RF", "lr": "LR", "rr": "RR"}
            name = " ".join(abbreviations.get(part.casefold(), part.capitalize()) for part in parts)
    duplicates[name.casefold()] = duplicates.get(name.casefold(), 0) + 1
    count = duplicates[name.casefold()]
    return f"{name} · {count}" if count > 1 else name


def dominant_bone_name(mesh: Any, skeleton: Any) -> str:
    if skeleton is None or not mesh.bone_ids or not mesh.blend_indices or not mesh.blend_weights:
        return ""
    import numpy as np

    if len(mesh.blend_indices) != len(mesh.blend_weights):
        return ""
    try:
        indices = np.asarray(mesh.blend_indices, dtype=np.int32)
        weights = np.asarray(mesh.blend_weights, dtype=np.float32)
        if indices.shape != weights.shape or indices.ndim != 2:
            return ""
        valid = (indices >= 0) & (indices < len(mesh.bone_ids)) & (weights > 0)
        totals = np.bincount(indices[valid], weights=weights[valid], minlength=len(mesh.bone_ids))
        if not totals.size or float(totals.max()) <= 0:
            return ""
        bone_index = mesh.bone_ids[int(totals.argmax())]
        bones_by_index = {item.index: item for item in skeleton.bones}
        bone = bones_by_index.get(bone_index)
        if bone and bone.name.casefold() in {"lf", "rf", "lr", "rr"}:
            parent = bones_by_index.get(bone.parent_index)
            if parent and parent.name.casefold().startswith("wheel_"):
                bone = parent
        return str(bone.name).strip() if bone else ""
    except (TypeError, ValueError, OverflowError):
        return ""


def mesh_texture_name(material: Any) -> str:
    if material is None:
        return ""
    for slot in ("DiffuseSampler", "DiffuseSampler2", "BaseColorSampler", "AlbedoSampler"):
        try:
            reference = material.get_texture(slot)
        except (AttributeError, KeyError, TypeError, ValueError):
            reference = None
        name = texture_reference_name(reference)
        if name:
            return name
    textures = getattr(material, "textures", None) or []
    return texture_reference_name(textures[0]) if textures else ""


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

    drawable = next(asset.iter_drawables(), None)
    skeleton = drawable.drawable.skeleton if drawable else None
    texture_references = {
        texture_key(mesh_texture_name(source.material))
        for source in meshes
        if mesh_texture_name(source.material)
    }

    texture_images: dict[str, Image.Image] = {}
    texture_candidates: dict[str, Texture] = {}
    for dictionary in dictionaries:
        if not isinstance(dictionary, dict):
            continue
        raw = decode_base64(dictionary.get("dataBase64"), "YTD file")
        ytd = read_ytd(raw)
        for texture in ytd.textures:
            key = texture_key(texture.name)
            if key:
                texture_candidates[key] = texture

    selected_keys = texture_references.intersection(texture_candidates)
    for reference_key in texture_references.difference(selected_keys):
        matches = [
            key
            for key in texture_candidates
            if len(key) >= 4 and (key.endswith(reference_key) or reference_key.endswith(key))
        ]
        if len(matches) == 1:
            selected_keys.add(matches[0])

    total_pixels = 0
    for key in selected_keys:
        texture = texture_candidates[key]
        total_pixels += max(texture.width, 0) * max(texture.height, 0)
        if total_pixels > MAX_PREVIEW_PIXELS:
            break
        try:
            image = image_from_texture(texture)
            texture_images[key] = image
            texture_images[texture.name.strip().casefold()] = image
        except Exception:
            continue

    scene = trimesh.Scene()
    used_textures: set[str] = set()
    unmatched_textures: set[str] = set()
    skipped = 0
    mesh_names: dict[str, int] = {}
    for index, source in enumerate(meshes):
        positions = np.fromiter(
            (float(component) for point in source.positions for component in (point.x, point.y, point.z)),
            dtype=np.float32,
            count=len(source.positions) * 3,
        ).reshape((-1, 3))
        indices = [int(value) for value in source.indices]
        if len(positions) < 3 or len(indices) < 3:
            skipped += 1
            continue
        indices = indices[: len(indices) - (len(indices) % 3)]
        if not indices or min(indices) < 0 or max(indices) >= len(positions):
            skipped += 1
            continue

        mesh = trimesh.Trimesh(
            vertices=positions[:, (0, 2, 1)] * np.asarray([1.0, 1.0, -1.0], dtype=np.float32),
            faces=np.asarray(indices, dtype=np.uint32).reshape((-1, 3)),
            process=False,
        )
        if len(source.normals) == len(positions):
            normals = np.fromiter(
                (float(component) for point in source.normals for component in (point.x, point.y, point.z)),
                dtype=np.float32,
                count=len(source.normals) * 3,
            ).reshape((-1, 3))
            mesh.vertex_normals = normals[:, (0, 2, 1)] * np.asarray([1.0, 1.0, -1.0], dtype=np.float32)

        source_material = source.material
        material_name = str(getattr(source_material, "name", "") or "")
        texture_name = mesh_texture_name(source_material) or None
        image = None
        if texture_name:
            leaf_name = texture_name.replace("\\", "/").rsplit("/", 1)[-1].strip()
            image = texture_images.get(leaf_name.casefold()) or texture_images.get(texture_key(leaf_name))
            if image is None:
                reference_key = texture_key(leaf_name)
                matches = {
                    id(candidate): candidate
                    for key, candidate in texture_images.items()
                    if len(key) >= 4 and (key.endswith(reference_key) or reference_key.endswith(key))
                } if len(reference_key) >= 4 else {}
                if len(matches) == 1:
                    image = next(iter(matches.values()))
            if image is None:
                unmatched_textures.add(leaf_name)
        uv_channels = source.texcoords or []
        if uv_channels and len(uv_channels[0]) == len(positions) and image is not None:
            uv = np.fromiter(
                (float(component) for point in uv_channels[0] for component in (point.x, point.y)),
                dtype=np.float32,
                count=len(uv_channels[0]) * 2,
            ).reshape((-1, 2))
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

        name = display_mesh_name(
            str(getattr(source, "name", "") or "") or dominant_bone_name(source, skeleton),
            material_name,
            index,
            mesh_names,
        )
        scene.add_geometry(mesh, geom_name=name, node_name=name)

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
        "unmatchedTextures": sorted(unmatched_textures),
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
