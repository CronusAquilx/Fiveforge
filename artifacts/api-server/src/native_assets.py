from __future__ import annotations

import base64
import io
import json
import re
import struct
import sys
from typing import Any
from urllib.parse import quote

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


def mesh_texture_slots(material: Any) -> dict[str, str]:
    if material is None:
        return {}
    slots: dict[str, str] = {}
    for texture in getattr(material, "textures", None) or []:
        slot = str(getattr(texture, "parameter_name", "") or "").strip()
        name = texture_reference_name(texture)
        if slot and name:
            slots[slot] = name
    for slot in ("DiffuseSampler", "DiffuseSampler2", "BaseColorSampler", "AlbedoSampler", "BumpSampler", "NormalSampler", "SpecSampler", "DirtSampler"):
        try:
            reference = material.get_texture(slot)
        except (AttributeError, KeyError, TypeError, ValueError):
            reference = None
        name = texture_reference_name(reference)
        if name:
            slots.setdefault(slot, name)
    return slots


def mesh_texture_name(material: Any) -> str:
    slots = mesh_texture_slots(material)
    for slot in ("DiffuseSampler", "BaseColorSampler", "AlbedoSampler", "DiffuseSampler2"):
        if slots.get(slot):
            return slots[slot]
    return next(iter(slots.values()), "")


def material_color(material: Any, shader_name: str) -> list[float]:
    if material is not None:
        for name in ("matDiffuseColor", "matDiffuseColor2", "diffuseColor", "MaterialColor"):
            try:
                parameter = material.get_parameter(name)
                value = getattr(parameter, "value", None)
                if isinstance(value, (int, float)):
                    values = [float(value)] * 3
                elif isinstance(value, (tuple, list)) and len(value) >= 3:
                    values = [float(value[index]) for index in range(3)]
                else:
                    continue
                if not all(0 <= value < float("inf") for value in values):
                    continue
                peak = max(values)
                if peak > 1.0:
                    values = [value / peak for value in values]
                return [max(0.0, min(1.0, value)) for value in values]
            except (AttributeError, KeyError, TypeError, ValueError, OverflowError):
                continue
    shader = shader_name.casefold()
    if "glass" in shader:
        return [0.52, 0.63, 0.7]
    if "paint" in shader:
        return [0.72, 0.72, 0.72]
    return [0.62, 0.62, 0.6]


def material_pbr_factors(shader_name: str, material: Any) -> tuple[float, float]:
    shader = shader_name.casefold()
    if "glass" in shader:
        return 0.06, 0.02
    if "paint" in shader:
        return 0.28, 0.18
    if "vehicle_mesh" in shader:
        return 0.52, 0.14
    if "light" in shader or "emissive" in shader:
        return 0.34, 0.05
    return 0.58, 0.04


def material_preview_name(material: Any, color: list[float]) -> str:
    material_name = str(getattr(material, "name", "") or "GTA material")
    shader_name = str(
        getattr(material, "shader_name", None)
        or getattr(material, "resolved_shader_file_name", None)
        or "unknown"
    )
    shader_name = re.sub(r"\.sps$", "", shader_name, flags=re.IGNORECASE)
    metadata = {
        "shader": shader_name,
        "textures": mesh_texture_slots(material),
        "baseColor": color,
    }
    return f"{material_name} · {shader_name} ||GTA||{quote(json.dumps(metadata, separators=(',', ':')), safe='')}"


def decode_binary_preview_bundle(data: bytes) -> dict[str, Any]:
    if len(data) < 4:
        raise ValueError("The vehicle upload is incomplete.")
    header_size = struct.unpack(">I", data[:4])[0]
    if header_size < 2 or header_size > 1024 * 1024 or 4 + header_size > len(data):
        raise ValueError("The vehicle upload has an invalid file index.")
    try:
        manifest = json.loads(data[4:4 + header_size].decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("The vehicle upload has an invalid file index.") from error
    files = manifest.get("files") if isinstance(manifest, dict) else None
    if not isinstance(files, list) or not 1 <= len(files) <= 25:
        raise ValueError("Choose one YFT and up to 24 matching YTD files.")

    offset = 4 + header_size
    model_data: bytes | None = None
    dictionaries: list[dict[str, Any]] = []
    for item in files:
        if not isinstance(item, dict):
            raise ValueError("The vehicle upload contains an invalid file entry.")
        name = str(item.get("name") or "vehicle.yft")
        size = item.get("size")
        role = item.get("role")
        if not isinstance(size, int) or size < 1 or size > MAX_FILE_BYTES or offset + size > len(data):
            raise ValueError("The vehicle upload contains an incomplete or oversized file.")
        file_data = data[offset:offset + size]
        offset += size
        if role == "model":
            if model_data is not None:
                raise ValueError("Upload exactly one YFT vehicle model.")
            model_data = file_data
        elif role == "texture":
            dictionaries.append({"name": name, "data": file_data})
        else:
            raise ValueError("The vehicle upload contains an unsupported file type.")
    if offset != len(data):
        raise ValueError("The vehicle upload contains unexpected trailing data.")
    if model_data is None:
        raise ValueError("The YFT vehicle model is missing.")
    if len(model_data) + sum(len(item["data"]) for item in dictionaries) > MAX_FILE_BYTES:
        raise ValueError("The YFT and its texture dictionaries exceed 250 MB.")
    return {
        "fileName": str(manifest.get("fileName") or "vehicle.yft"),
        "modelData": model_data,
        "textureDictionaries": dictionaries,
    }


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
    model_data = payload.get("modelData")
    if not isinstance(model_data, bytes):
        model_data = decode_base64(payload.get("modelBase64"), "YFT file")
    dictionaries = payload.get("textureDictionaries") or []
    if not isinstance(dictionaries, list) or len(dictionaries) > 24:
        raise ValueError("Choose up to 24 associated YTD dictionaries.")

    import numpy as np
    import trimesh

    asset = Yft.from_bytes(model_data, path=str(payload.get("fileName") or "vehicle.yft"))
    meshes = []
    for lod in ("high", "med", "low", "vlow"):
        try:
            candidate = asset.meshes(lod=lod)
        except Exception:
            continue
        if candidate and any(
            len(getattr(mesh, "positions", []) or []) >= 3
            and len(getattr(mesh, "indices", []) or []) >= 3
            for mesh in candidate
        ):
            meshes = candidate
            break
    if not meshes:
        try:
            meshes = asset.meshes()
        except Exception:
            meshes = []
    if not meshes:
        raise ValueError("This YFT was read, but it contains no render meshes for the preview.")
    if len(meshes) > 600:
        raise ValueError("This YFT contains too many meshes to preview safely.")

    drawables = list(asset.iter_drawables())
    skeleton = next(
        (item.drawable.skeleton for item in drawables if getattr(item.drawable, "skeleton", None)),
        None,
    )
    render_slots = {
        "diffusesampler", "diffusesampler2", "basecolorsampler", "albedosampler",
        "bumpsampler", "normalsampler",
    }
    texture_references = {
        texture_key(name)
        for source in meshes
        for slot, name in mesh_texture_slots(source.material).items()
        if slot.casefold() in render_slots and texture_key(name)
    }

    texture_images: dict[str, Image.Image] = {}
    texture_candidates: dict[str, Texture] = {}
    texture_errors: list[str] = []
    for dictionary in dictionaries:
        if not isinstance(dictionary, dict):
            continue
        raw = dictionary.get("data")
        name = str(dictionary.get("name") or "YTD file")
        if not isinstance(raw, bytes):
            raw = decode_base64(dictionary.get("dataBase64"), name)
        try:
            ytd = read_ytd(raw)
        except Exception as error:
            texture_errors.append(f"{name}: {str(error)[:140]}")
            continue
        for texture in ytd.textures:
            key = texture_key(texture.name)
            if key:
                texture_candidates.setdefault(key, texture)

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
    material_names: set[str] = set()
    skipped = 0
    mesh_names: dict[str, int] = {}

    def find_texture(name: str) -> Image.Image | None:
        leaf_name = name.replace("\\", "/").rsplit("/", 1)[-1].strip()
        image = texture_images.get(leaf_name.casefold()) or texture_images.get(texture_key(leaf_name))
        if image is not None:
            return image
        reference_key = texture_key(leaf_name)
        matches = {
            id(candidate): candidate
            for key, candidate in texture_images.items()
            if len(reference_key) >= 4 and len(key) >= 4
            and (key.endswith(reference_key) or reference_key.endswith(key))
        }
        return next(iter(matches.values())) if len(matches) == 1 else None

    def uv_index_for(material: Any, slot_name: str) -> int:
        for reference in getattr(material, "textures", None) or []:
            if str(getattr(reference, "parameter_name", "")).casefold() == slot_name.casefold():
                return max(0, int(getattr(reference, "uv_index", 0) or 0))
        return 0

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
        texture_slots = mesh_texture_slots(source_material)
        diffuse_slot = next(
            (slot for slot in ("DiffuseSampler", "BaseColorSampler", "AlbedoSampler", "DiffuseSampler2") if texture_slots.get(slot)),
            None,
        )
        normal_slot = next(
            (slot for slot in ("BumpSampler", "NormalSampler") if texture_slots.get(slot)),
            None,
        )
        diffuse_name = texture_slots.get(diffuse_slot or "", "")
        normal_name = texture_slots.get(normal_slot or "", "")
        image = find_texture(diffuse_name) if diffuse_name else None
        normal_image = find_texture(normal_name) if normal_name else None
        if diffuse_name and image is None:
            unmatched_textures.add(diffuse_name.replace("\\", "/").rsplit("/", 1)[-1].strip())
        if normal_name and normal_image is None:
            unmatched_textures.add(normal_name.replace("\\", "/").rsplit("/", 1)[-1].strip())

        uv_channels = source.texcoords or []
        diffuse_uv_index = uv_index_for(source_material, diffuse_slot or "")
        selected_uv_index = diffuse_uv_index if image is not None else uv_index_for(source_material, normal_slot or "")
        uv = None
        if selected_uv_index < len(uv_channels) and len(uv_channels[selected_uv_index]) == len(positions):
            uv = np.fromiter(
                (float(component) for point in uv_channels[selected_uv_index] for component in (point.x, point.y)),
                dtype=np.float32,
                count=len(uv_channels[selected_uv_index]) * 2,
            ).reshape((-1, 2))
        if image is not None:
            used_textures.add(diffuse_name)
        if normal_image is not None and uv is not None and uv_index_for(source_material, normal_slot or "") == selected_uv_index:
            used_textures.add(normal_name)
        else:
            normal_image = None

        shader_name = str(
            getattr(source_material, "shader_name", None)
            or getattr(source_material, "resolved_shader_file_name", None)
            or ""
        )
        color = material_color(source_material, shader_name)
        roughness, metallic = material_pbr_factors(shader_name, source_material)
        material = trimesh.visual.material.PBRMaterial(
            name=material_preview_name(source_material, color),
            baseColorTexture=image if uv is not None else None,
            baseColorFactor=[round(channel * 255) for channel in color] + [255],
            normalTexture=normal_image if uv is not None else None,
            roughnessFactor=roughness,
            metallicFactor=metallic,
        )
        mesh.visual = trimesh.visual.TextureVisuals(uv=uv, material=material)
        if shader_name:
            material_names.add(shader_name)

        source_name = str(getattr(source, "name", "") or "")
        if not source_name or re.fullmatch(r"(?:mesh|object|geometry|primitive|shape)(?:[._\s-]*\d+)?", source_name.strip(), re.IGNORECASE):
            source_name = dominant_bone_name(source, skeleton)
        name = display_mesh_name(
            source_name,
            str(getattr(source_material, "name", "") or ""),
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
        "modelGlb": glb,
        "meshCount": len(scene.geometry),
        "skippedMeshCount": skipped,
        "textureCount": len(used_textures),
        "usedTextures": sorted(used_textures),
        "unmatchedTextures": sorted(unmatched_textures),
        "textureErrors": texture_errors,
        "gtaShaders": sorted(material_names),
    }


def main() -> None:
    operation = sys.argv[1] if len(sys.argv) > 1 else ""
    try:
        payload = decode_binary_preview_bundle(sys.stdin.buffer.read()) if operation == "preview-yft-binary" else json.load(sys.stdin)
        if not isinstance(payload, dict):
            raise ValueError("Request body must be an object.")
        if operation == "decode-ytd":
            result = decode_ytd(payload)
        elif operation == "replace-ytd":
            result = replace_ytd(payload)
        elif operation in {"preview-yft", "preview-yft-binary"}:
            result = preview_yft(payload)
            glb = result.pop("modelGlb")
            if operation == "preview-yft-binary":
                header = json.dumps(result, separators=(",", ":")).encode("utf-8")
                sys.stdout.buffer.write(struct.pack(">I", len(header)))
                sys.stdout.buffer.write(header)
                sys.stdout.buffer.write(glb)
                return
            result["modelBase64"] = base64.b64encode(glb).decode("ascii")
        else:
            raise ValueError("Unknown native asset operation.")
        sys.stdout.write(json.dumps(result, separators=(",", ":")))
    except Exception as error:
        sys.stderr.write(f"{type(error).__name__}: {error}\n")
        sys.stdout.write(json.dumps({"error": str(error)}, separators=(",", ":")))
        sys.exit(1)


if __name__ == "__main__":
    main()
