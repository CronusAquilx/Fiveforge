from __future__ import annotations

import base64
import dataclasses
import io
import json
import math
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


EXTRA_VARIANTS = {
    "flip": "flipped",
    "flipped": "flipped",
    "reverse": "reversed",
    "reversed": "reversed",
    "mirror": "mirrored",
    "mirrored": "mirrored",
}
EXTRA_INDEX_WORDS = {
    "zero": "0",
    "one": "1",
    "two": "2",
    "three": "3",
    "four": "4",
    "five": "5",
    "six": "6",
    "seven": "7",
    "eight": "8",
    "nine": "9",
    "ten": "10",
    "eleven": "11",
    "twelve": "12",
    "thirteen": "13",
    "fourteen": "14",
    "fifteen": "15",
    "sixteen": "16",
    "seventeen": "17",
    "eighteen": "18",
    "nineteen": "19",
    "twenty": "20",
}
EXTRA_COMPACT_INDEX_PATTERN = "|".join(
    [r"\d+", *EXTRA_INDEX_WORDS.keys()]
)
EXTRA_NAME_PATTERNS = (
    re.compile(
        rf"(?<![a-z0-9])(?P<variant>flipped|flip|reversed|reverse|mirrored|mirror)[_.\s-]*extra(?:[_.\s-]+(?P<index>[a-z0-9]+)|(?P<compact_index>{EXTRA_COMPACT_INDEX_PATTERN}))(?![a-z0-9])",
        re.IGNORECASE,
    ),
    re.compile(
        rf"(?<![a-z0-9])extra[_.\s-]*(?P<variant>flipped|flip|reversed|reverse|mirrored|mirror)(?:[_.\s-]+(?P<index>[a-z0-9]+)|(?P<compact_index>{EXTRA_COMPACT_INDEX_PATTERN}))(?![a-z0-9])",
        re.IGNORECASE,
    ),
    re.compile(
        r"(?<![a-z0-9])extra[_.\s-]+(?P<index>[a-z0-9]+?)[_.\s-]*(?P<variant>flipped|flip|reversed|reverse|mirrored|mirror)(?![a-z0-9])",
        re.IGNORECASE,
    ),
    re.compile(
        rf"(?<![a-z0-9])extra(?P<compact_index>{EXTRA_COMPACT_INDEX_PATTERN})(?P<variant>flipped|flip|reversed|reverse|mirrored|mirror)(?![a-z0-9])",
        re.IGNORECASE,
    ),
    re.compile(
        r"(?<![a-z0-9])extra[_.\s-]+(?P<index>[a-z0-9]+)(?![a-z0-9])",
        re.IGNORECASE,
    ),
    re.compile(
        rf"(?<![a-z0-9])extra(?P<compact_index>{EXTRA_COMPACT_INDEX_PATTERN})(?![a-z0-9])",
        re.IGNORECASE,
    ),
)


def extra_part_from_name(name: str) -> dict[str, str] | None:
    for pattern in EXTRA_NAME_PATTERNS:
        match = pattern.search(name.strip())
        if not match:
            continue
        groups = match.groupdict()
        raw_index = (groups.get("index") or groups.get("compact_index") or "").casefold()
        index = EXTRA_INDEX_WORDS.get(raw_index, raw_index)
        if index.isdigit():
            index = str(int(index))
        variant = EXTRA_VARIANTS.get((groups.get("variant") or "").casefold(), "")
        id = f"extra:{index}:{variant or 'normal'}"
        label = f"Extra {index}"
        if variant:
            label += f" · {variant.capitalize()}"
        return {"id": id, "label": label}
    return None


def extra_sort_key(part: dict[str, str]) -> tuple[int, int | str, str]:
    index = part["id"].split(":")[1]
    if index.isdigit():
        return (0, int(index), part["id"].split(":")[2])
    return (1, index, part["id"].split(":")[2])


def vehicle_extra_parts(drawables: list[Any]) -> list[dict[str, str]]:
    parts: dict[str, dict[str, str]] = {}
    for item in drawables:
        drawable = getattr(item, "drawable", None)
        names = [
            str(getattr(item, "name", "") or ""),
            str(getattr(drawable, "name", "") or ""),
        ]
        skeleton = getattr(drawable, "skeleton", None)
        if skeleton is not None:
            names.extend(str(getattr(bone, "name", "") or "") for bone in skeleton.bones)

        # Some resources label extras on drawable or mesh names instead of bones.
        # Walk every drawable model/LOD so inspection is not limited to the LOD
        # selected for the viewport preview.
        if drawable is not None:
            try:
                for model in drawable.iter_models():
                    names.extend(
                        str(getattr(mesh, "name", "") or "")
                        for mesh in getattr(model, "meshes", []) or []
                    )
            except (AttributeError, TypeError, ValueError):
                pass

        for name in names:
            part = extra_part_from_name(name)
            if part:
                parts.setdefault(part["id"], part)
    return sorted(parts.values(), key=extra_sort_key)


def mesh_extra_parts(mesh: Any, skeleton: Any) -> list[dict[str, str]]:
    if skeleton is None or not mesh.bone_ids or not mesh.blend_indices or not mesh.blend_weights:
        return []
    import numpy as np

    try:
        indices = np.asarray(mesh.blend_indices, dtype=np.int32)
        weights = np.asarray(mesh.blend_weights, dtype=np.float32)
        if indices.shape != weights.shape or indices.ndim != 2:
            return []
        valid = (indices >= 0) & (indices < len(mesh.bone_ids)) & (weights > 0)
        used_bones = {
            mesh.bone_ids[int(index)]
            for index in np.unique(indices[valid])
        }
        bones_by_index = {item.index: item for item in skeleton.bones}
        parts: dict[str, dict[str, str]] = {}
        for bone_index in used_bones:
            bone = bones_by_index.get(bone_index)
            part = extra_part_from_name(str(getattr(bone, "name", "") or "")) if bone else None
            if part:
                parts.setdefault(part["id"], part)
        return sorted(parts.values(), key=extra_sort_key)
    except (TypeError, ValueError, OverflowError):
        return []


def mesh_extra_face_groups(mesh: Any, skeleton: Any, faces: Any) -> dict[str | None, Any]:
    import numpy as np

    face_rows = np.asarray(faces, dtype=np.int64)
    if face_rows.ndim != 2 or face_rows.shape[1] != 3:
        return {}
    if skeleton is None or not mesh.bone_ids or not mesh.blend_indices or not mesh.blend_weights:
        return {None: np.arange(len(face_rows), dtype=np.int64)}
    try:
        indices = np.asarray(mesh.blend_indices, dtype=np.int32)
        weights = np.asarray(mesh.blend_weights, dtype=np.float32)
        if indices.shape != weights.shape or indices.ndim != 2 or len(indices) == 0:
            return {None: np.arange(len(face_rows), dtype=np.int64)}
        bones_by_index = {item.index: item for item in skeleton.bones}
        extra_weights: dict[str, tuple[dict[str, str], Any]] = {}
        for palette_index, bone_index in enumerate(mesh.bone_ids):
            bone = bones_by_index.get(bone_index)
            part = extra_part_from_name(str(getattr(bone, "name", "") or "")) if bone else None
            if not part:
                continue
            per_vertex = np.sum(np.where(indices == palette_index, weights, 0.0), axis=1)
            if part["id"] in extra_weights:
                previous_part, previous_weights = extra_weights[part["id"]]
                extra_weights[part["id"]] = (previous_part, previous_weights + per_vertex)
            else:
                extra_weights[part["id"]] = (part, per_vertex)
        if not extra_weights:
            return {None: np.arange(len(face_rows), dtype=np.int64)}

        total_weights = np.sum(np.maximum(weights, 0.0), axis=1)
        all_extra_weights = np.sum(np.stack([entry[1] for entry in extra_weights.values()], axis=1), axis=1)
        base_weights = np.maximum(total_weights - all_extra_weights, 0.0)
        part_rows = sorted(extra_weights.items(), key=lambda item: extra_sort_key(item[1][0]))
        per_face_base = np.sum(base_weights[face_rows], axis=1)
        per_face_extras = np.stack([
            np.sum(extra_weights[part_id][1][face_rows], axis=1)
            for part_id, _ in part_rows
        ], axis=1)
        winning_extra = np.argmax(per_face_extras, axis=1)
        winning_score = np.max(per_face_extras, axis=1)
        winners: list[str | None] = [
            part_rows[int(index)][0] if score > base else None
            for index, score, base in zip(winning_extra, winning_score, per_face_base)
        ]
        result: dict[str | None, Any] = {}
        for category in dict.fromkeys(winners):
            result[category] = np.asarray([index for index, winner in enumerate(winners) if winner == category], dtype=np.int64)
        return result
    except (IndexError, TypeError, ValueError, OverflowError):
        return {None: np.arange(len(face_rows), dtype=np.int64)}


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


def diffuse_texture_slot(
    shader_name: str,
    texture_slots: dict[str, str],
    texture_exists: Any = None,
) -> str | None:
    shader = shader_name.casefold()
    if "vehicle_paint" in shader or "vehiclepaint" in shader:
        candidates = ("DiffuseSampler2", "BaseColorSampler", "AlbedoSampler", "DiffuseSampler")
    else:
        candidates = ("BaseColorSampler", "AlbedoSampler", "DiffuseSampler", "DiffuseSampler2")
    available = [slot for slot in candidates if texture_slots.get(slot)]
    if texture_exists:
        return next(
            (slot for slot in available if texture_exists(texture_slots[slot])),
            available[0] if available else None,
        )
    return available[0] if available else None


def mesh_texture_name(material: Any) -> str:
    slots = mesh_texture_slots(material)
    shader_name = str(
        getattr(material, "shader_name", None)
        or getattr(material, "resolved_shader_file_name", None)
        or ""
    )
    slot = diffuse_texture_slot(shader_name, slots)
    if slot:
        return slots[slot]
    return next(iter(slots.values()), "")


def material_color(material: Any, shader_name: str) -> list[float]:
    if "vehicle_paint" in shader_name.casefold() or "vehiclepaint" in shader_name.casefold():
        return [1.0, 1.0, 1.0]
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


def decode_binary_rebuild_bundle(data: bytes) -> dict[str, Any]:
    if len(data) < 4:
        raise ValueError("The native YFT edit upload is incomplete.")
    header_size = struct.unpack(">I", data[:4])[0]
    if header_size < 2 or header_size > 1024 * 1024 or 4 + header_size > len(data):
        raise ValueError("The native YFT edit upload has an invalid file index.")
    try:
        manifest = json.loads(data[4:4 + header_size].decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("The native YFT edit upload has an invalid file index.") from error
    files = manifest.get("files") if isinstance(manifest, dict) else None
    edits = manifest.get("edits") if isinstance(manifest, dict) else None
    source_path = manifest.get("sourcePath") if isinstance(manifest, dict) else None
    source_lod = manifest.get("sourceLod") if isinstance(manifest, dict) else None
    if not isinstance(files, list) or not 1 <= len(files) <= 24:
        raise ValueError("Choose one or more related YFT files, up to 24.")
    if not isinstance(source_path, str) or not source_path:
        raise ValueError("The edited source YFT is missing from this export.")
    if not isinstance(source_lod, str) or source_lod not in {"high", "med", "low", "vlow"}:
        raise ValueError("The previewed YFT LOD is invalid.")
    if not isinstance(edits, list) or not 1 <= len(edits) <= 600:
        raise ValueError("No supported native geometry edits were supplied.")

    offset = 4 + header_size
    total_size = 0
    models: list[dict[str, Any]] = []
    seen_paths: set[str] = set()
    for item in files:
        if not isinstance(item, dict):
            raise ValueError("The native YFT edit upload contains an invalid file entry.")
        name = str(item.get("name") or "")
        role = item.get("role")
        size = item.get("size")
        normalized_path = name.replace("\\", "/").casefold()
        if (
            role != "model"
            or not name.lower().endswith(".yft")
            or not normalized_path
            or normalized_path in seen_paths
            or not isinstance(size, int)
            or size < 1
            or size > MAX_FILE_BYTES
            or offset + size > len(data)
        ):
            raise ValueError("The native YFT edit upload contains an invalid or oversized YFT file.")
        seen_paths.add(normalized_path)
        models.append({"name": name, "data": data[offset:offset + size]})
        offset += size
        total_size += size
    if offset != len(data):
        raise ValueError("The native YFT edit upload contains unexpected trailing data.")
    if total_size > MAX_FILE_BYTES:
        raise ValueError("The related YFT files exceed the 250 MB native edit limit.")
    if not any(item["name"].replace("\\", "/").casefold() == source_path.replace("\\", "/").casefold() for item in models):
        raise ValueError("The edited source YFT is not included in this export.")

    validated_edits: list[dict[str, Any]] = []
    seen_indices: set[int] = set()
    for item in edits:
        if not isinstance(item, dict):
            raise ValueError("The native geometry edit list contains an invalid entry.")
        mesh_index = item.get("meshIndex")
        matrix = item.get("matrix")
        removed = item.get("removed", False)
        if (
            not isinstance(mesh_index, int)
            or mesh_index < 0
            or mesh_index in seen_indices
            or not isinstance(removed, bool)
            or (not removed and (
                not isinstance(matrix, list)
                or len(matrix) != 16
                or any(not isinstance(value, (int, float)) or not math.isfinite(value) for value in matrix)
            ))
        ):
            raise ValueError("The native geometry edit list contains an invalid transform or mesh index.")
        seen_indices.add(mesh_index)
        validated_edits.append({
            "meshIndex": mesh_index,
            "matrix": [float(value) for value in matrix] if not removed else None,
            "removed": removed,
        })
    return {
        "sourcePath": source_path,
        "sourceLod": source_lod,
        "edits": validated_edits,
        "models": models,
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
    selected_lod: str | None = None
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
            selected_lod = lod
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
    mesh_extra_ids: set[str] = set()
    native_mesh_map: dict[int, dict[str, Any]] = {}

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
        shader_name = str(
            getattr(source_material, "shader_name", None)
            or getattr(source_material, "resolved_shader_file_name", None)
            or ""
        )
        texture_slots = mesh_texture_slots(source_material)
        diffuse_slot = diffuse_texture_slot(shader_name, texture_slots, find_texture)
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
        if not source_name or re.fullmatch(
            r"(?:mesh|object|geometry|primitive|shape|material)(?:[._\s-]*\d+)?",
            source_name.strip(),
            re.IGNORECASE,
        ):
            source_name = dominant_bone_name(source, skeleton)
        name = display_mesh_name(
            source_name,
            str(getattr(source_material, "name", "") or ""),
            index,
            mesh_names,
        )
        extra_parts = mesh_extra_parts(source, skeleton)
        part_by_id = {part["id"]: part for part in extra_parts}
        if source_name:
            named_extra = extra_part_from_name(source_name)
            if named_extra:
                part_by_id.setdefault(named_extra["id"], named_extra)
        face_groups = mesh_extra_face_groups(source, skeleton, mesh.faces)
        if not any(part_id is not None for part_id in face_groups) and source_name:
            named_extra = extra_part_from_name(source_name)
            if named_extra:
                part_by_id.setdefault(named_extra["id"], named_extra)
                face_groups = {named_extra["id"]: np.arange(len(mesh.faces), dtype=np.int64)}
        base_name = f"Vehicle part {index + 1:02d}" if extra_part_from_name(name) else name
        nonempty_groups = [(part_id, face_indices) for part_id, face_indices in face_groups.items() if len(face_indices)]
        for part_index, (part_id, face_indices) in enumerate(nonempty_groups):
            if part_id is None and len(nonempty_groups) == 1:
                part_mesh = mesh
                part_name = base_name
            else:
                part_mesh = mesh.submesh([face_indices], append=True, repair=False)
                if not isinstance(part_mesh, trimesh.Trimesh):
                    continue
                if part_id is None:
                    part_name = base_name
                else:
                    part = part_by_id.get(part_id)
                    if not part:
                        continue
                    mesh_extra_ids.add(part_id)
                    part_name = f"{name} · {part['label']}"
            node_name = f"FFYFTMESH{index:05d}PART{part_index:03d}__{part_name}"
            scene.add_geometry(part_mesh, geom_name=part_name, node_name=node_name)
            entry = native_mesh_map.setdefault(
                index,
                {"meshIndex": index, "label": name, "nodeCount": 0},
            )
            entry["nodeCount"] += 1

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
        "extras": vehicle_extra_parts(drawables),
        "meshExtras": sorted(mesh_extra_ids, key=lambda id: extra_sort_key({"id": id, "label": id})),
        "nativeMeshLod": selected_lod or "unknown",
        "nativeMeshMap": [native_mesh_map[index] for index in sorted(native_mesh_map)],
    }


def inspect_yft_extras(payload: dict[str, Any]) -> dict[str, Any]:
    data = decode_base64(payload.get("modelBase64"), "YFT file")
    file_name = str(payload.get("fileName") or "vehicle.yft")
    asset = Yft.from_bytes(data, path=file_name)
    return {
        "fileName": file_name,
        "extras": vehicle_extra_parts(list(asset.iter_drawables())),
    }


def _yft_meshes_for_lod(asset: Yft, preferred_lod: str) -> tuple[str, list[Any]]:
    for lod in (preferred_lod, "high", "med", "low", "vlow"):
        if lod not in {"high", "med", "low", "vlow"}:
            continue
        try:
            meshes = list(asset.meshes(lod=lod))
        except Exception:
            continue
        if meshes:
            return lod, meshes
    raise ValueError("A related YFT file has no supported render LOD.")


def _yft_skeleton(asset: Yft) -> Any:
    return next(
        (
            item.drawable.skeleton
            for item in asset.iter_drawables()
            if getattr(item.drawable, "skeleton", None)
        ),
        None,
    )


def _yft_mesh_signature(mesh: Any, skeleton: Any) -> dict[str, Any]:
    positions = list(getattr(mesh, "positions", None) or [])
    if not positions:
        return {"bone": "", "center": (0.0, 0.0, 0.0), "extent": (0.0, 0.0, 0.0), "shader": "", "textures": ()}
    minimum = tuple(min(float(getattr(point, axis)) for point in positions) for axis in "xyz")
    maximum = tuple(max(float(getattr(point, axis)) for point in positions) for axis in "xyz")
    center = tuple((minimum[index] + maximum[index]) / 2.0 for index in range(3))
    extent = tuple(maximum[index] - minimum[index] for index in range(3))
    material = getattr(mesh, "material", None)
    textures = mesh_texture_slots(material)
    return {
        "bone": dominant_bone_name(mesh, skeleton).casefold(),
        "center": center,
        "extent": extent,
        "shader": str(
            getattr(material, "shader_name", None)
            or getattr(material, "resolved_shader_file_name", None)
            or ""
        ).casefold(),
        "textures": tuple(sorted((str(key).casefold(), texture_key(str(value))) for key, value in textures.items() if value)),
    }


def _mesh_signature_cost(left: dict[str, Any], right: dict[str, Any]) -> float | None:
    if not left["bone"] or left["bone"] != right["bone"]:
        return None
    import numpy as np

    center_distance = float(np.linalg.norm(np.asarray(left["center"]) - np.asarray(right["center"])))
    extent_distance = float(np.linalg.norm(np.asarray(left["extent"]) - np.asarray(right["extent"])))
    texture_penalty = 0.0 if left["textures"] == right["textures"] else 0.15
    shader_penalty = 0.0 if left["shader"] == right["shader"] else 0.4
    return center_distance + 0.25 * extent_distance + texture_penalty + shader_penalty


def _paired_mesh_index(
    source_index: int,
    source_signatures: list[dict[str, Any]],
    target_signatures: list[dict[str, Any]],
    target_label: str,
) -> int:
    if source_index < 0 or source_index >= len(source_signatures):
        raise ValueError(f"Edited YFT mesh {source_index} is outside the previewed source mesh list.")
    source_signature = source_signatures[source_index]
    target_candidates = sorted(
        (
            (cost, index)
            for index, signature in enumerate(target_signatures)
            if (cost := _mesh_signature_cost(source_signature, signature)) is not None
        ),
        key=lambda item: item[0],
    )
    if not target_candidates:
        raise ValueError(
            f"Could not safely match edited mesh {source_index + 1} to {target_label}; "
            "the native export was stopped to avoid a mismatched LOD."
        )
    best_cost, target_index = target_candidates[0]
    target_margin = target_candidates[1][0] - best_cost if len(target_candidates) > 1 else float("inf")
    reverse_candidates = sorted(
        (
            (cost, index)
            for index, signature in enumerate(source_signatures)
            if (cost := _mesh_signature_cost(signature, target_signatures[target_index])) is not None
        ),
        key=lambda item: item[0],
    )
    reverse_margin = (
        reverse_candidates[1][0] - reverse_candidates[0][0]
        if len(reverse_candidates) > 1
        else float("inf")
    )
    if (
        best_cost >= 0.45
        or target_margin <= 0.05
        or not reverse_candidates
        or reverse_candidates[0][1] != source_index
        or reverse_margin <= 0.05
    ):
        raise ValueError(
            f"Could not uniquely match edited mesh {source_index + 1} to {target_label}; "
            "the native export was stopped to avoid a mismatched LOD."
        )
    return target_index


def _apply_yft_transform(mesh: Any, column_major_matrix: list[float]) -> None:
    import numpy as np

    if len(column_major_matrix) != 16:
        raise ValueError("A native mesh transform must contain 16 matrix values.")
    preview_matrix = np.asarray(column_major_matrix, dtype=np.float64).reshape((4, 4), order="F")
    if not np.isfinite(preview_matrix).all() or not np.allclose(preview_matrix[3], (0, 0, 0, 1), atol=1e-6):
        raise ValueError("Perspective transforms cannot be written to native YFT meshes.")
    coordinate_conversion = np.asarray(
        (
            (1.0, 0.0, 0.0, 0.0),
            (0.0, 0.0, 1.0, 0.0),
            (0.0, -1.0, 0.0, 0.0),
            (0.0, 0.0, 0.0, 1.0),
        ),
        dtype=np.float64,
    )
    native_matrix = coordinate_conversion.T @ preview_matrix @ coordinate_conversion
    linear = native_matrix[:3, :3]
    determinant = float(np.linalg.det(linear))
    if abs(determinant) < 1e-8:
        raise ValueError("A zero-scale native mesh transform cannot be exported.")

    positions = list(getattr(mesh, "positions", None) or [])
    if not positions:
        raise ValueError("A native YFT mesh has no editable vertex positions.")
    source_positions = np.asarray([(point.x, point.y, point.z) for point in positions], dtype=np.float64)
    homogeneous = np.column_stack((source_positions, np.ones(len(source_positions), dtype=np.float64)))
    transformed = homogeneous @ native_matrix.T
    mesh.positions = [
        type(point)(float(value[0]), float(value[1]), float(value[2]))
        for point, value in zip(positions, transformed)
    ]

    normal_matrix = np.linalg.inv(linear).T
    for attribute in ("normals", "tangents"):
        values = list(getattr(mesh, attribute, None) or [])
        if not values:
            continue
        if len(values) != len(positions):
            raise ValueError(f"The native mesh has an incompatible {attribute} buffer; its edit was not exported.")
        directions = np.asarray([(value.x, value.y, value.z) for value in values], dtype=np.float64)
        transformed_directions = directions @ normal_matrix.T
        lengths = np.linalg.norm(transformed_directions, axis=1)
        nonzero = lengths > 1e-12
        transformed_directions[nonzero] /= lengths[nonzero, None]
        updated = []
        for value, direction in zip(values, transformed_directions):
            components = [float(direction[0]), float(direction[1]), float(direction[2])]
            if hasattr(value, "w"):
                handedness = float(value.w) * (-1.0 if determinant < 0 else 1.0)
                updated.append(type(value)(*components, handedness))
            else:
                updated.append(type(value)(*components))
        setattr(mesh, attribute, updated)

    if determinant < 0:
        indices = list(getattr(mesh, "indices", None) or [])
        if len(indices) % 3:
            raise ValueError("A mirrored YFT mesh has an unsupported index layout.")
        for index in range(0, len(indices), 3):
            indices[index + 1], indices[index + 2] = indices[index + 2], indices[index + 1]
        mesh.indices = indices


def _remove_yft_mesh(asset: Yft, lod: str, target_mesh: Any) -> None:
    for drawable in asset.iter_drawables():
        models = getattr(drawable.drawable, "lods", {}).get(lod, [])
        for model in models:
            meshes = getattr(model, "meshes", None)
            if isinstance(meshes, list) and any(mesh is target_mesh for mesh in meshes):
                meshes[:] = [mesh for mesh in meshes if mesh is not target_mesh]
                return
    raise ValueError("Could not safely remove a selected mesh from the native YFT.")


def _writer_shader_library(assets: list[Yft]) -> Any:
    from fivefury import load_shader_library

    matrix_counts: dict[tuple[str, str], int] = {}
    for asset in assets:
        for drawable in asset.iter_drawables():
            for material in getattr(drawable.drawable, "materials", []) or []:
                shader_name = str(getattr(material, "shader_name", "") or "").casefold()
                for parameter in getattr(material, "parameters", []) or []:
                    if (
                        str(getattr(parameter, "type_name", "") or "").casefold() == "float4x4"
                        and isinstance(getattr(parameter, "value", None), (tuple, list))
                        and len(parameter.value) == 4
                    ):
                        matrix_counts[(shader_name, str(parameter.name).casefold())] = 4
    library = load_shader_library()
    shaders = []
    for shader in library.shaders:
        parameters = tuple(
            dataclasses.replace(
                parameter,
                count=matrix_counts.get((shader.name.casefold(), parameter.name.casefold()), parameter.count),
            )
            for parameter in shader.parameters
        )
        shaders.append(dataclasses.replace(shader, parameters=parameters) if parameters != shader.parameters else shader)
    return type(library)(tuple(shaders))


def rebuild_yft_binary(payload: dict[str, Any]) -> dict[str, Any]:
    from fivefury import build_yft_bytes

    source_path = str(payload["sourcePath"])
    source_key = source_path.replace("\\", "/").casefold()
    source_lod = str(payload["sourceLod"])
    edits = list(payload["edits"])
    models = list(payload["models"])
    parsed: list[dict[str, Any]] = []
    for item in models:
        asset = Yft.from_bytes(item["data"], path=item["name"])
        parsed.append({"name": item["name"], "data": item["data"], "asset": asset})
    source_entry = next(
        item for item in parsed
        if item["name"].replace("\\", "/").casefold() == source_key
    )
    _, source_meshes = _yft_meshes_for_lod(source_entry["asset"], source_lod)
    source_signatures = [
        _yft_mesh_signature(mesh, _yft_skeleton(source_entry["asset"]))
        for mesh in source_meshes
    ]
    output_files: list[tuple[str, bytes]] = []

    for item in parsed:
        asset = item["asset"]
        is_source = item is source_entry
        target_lod, target_meshes = _yft_meshes_for_lod(asset, source_lod)
        target_skeleton = _yft_skeleton(asset)
        if not is_source:
            target_signatures = [
                _yft_mesh_signature(mesh, target_skeleton)
                for mesh in target_meshes
            ]
        else:
            target_signatures = source_signatures
        mapped_edits: list[tuple[int, dict[str, Any]]] = []
        claimed_meshes: set[int] = set()
        for edit in edits:
            source_index = int(edit["meshIndex"])
            if is_source:
                target_index = source_index
                if target_index >= len(target_meshes):
                    raise ValueError(f"Edited YFT mesh {source_index + 1} is missing from {item['name']}.")
            else:
                target_index = _paired_mesh_index(
                    source_index,
                    source_signatures,
                    target_signatures,
                    item["name"],
                )
            if target_index in claimed_meshes:
                raise ValueError(f"Two edited meshes mapped to one part in {item['name']}; export stopped.")
            claimed_meshes.add(target_index)
            mapped_edits.append((target_index, edit))

        removed_meshes = 0
        for target_index, edit in mapped_edits:
            target_mesh = target_meshes[target_index]
            if edit["removed"]:
                _remove_yft_mesh(asset, target_lod, target_mesh)
                removed_meshes += 1
            else:
                _apply_yft_transform(target_mesh, edit["matrix"])
        if not list(asset.meshes(lod=target_lod)):
            raise ValueError(f"Removing the selected meshes would leave {item['name']} without render geometry.")

        shader_library = _writer_shader_library([asset])
        try:
            rebuilt = build_yft_bytes(asset, shader_library=shader_library)
        except Exception as error:
            raise ValueError(f"Could not rebuild {item['name']} as native YFT: {error}") from error
        roundtrip = Yft.from_bytes(rebuilt, path=item["name"])
        report = roundtrip.validate()
        if getattr(report, "errors", []):
            raise ValueError(
                f"The rebuilt YFT failed binary validation: {item['name']} "
                f"({len(report.errors)} error(s))."
            )
        output_files.append((item["name"], rebuilt))

    metadata = {
        "sourcePath": source_path,
        "files": [{"path": name, "size": len(data)} for name, data in output_files],
        "editsApplied": len(edits),
        "warnings": ["Render geometry was rebuilt; original vehicle collision and physics data were preserved."],
    }
    return {"metadata": metadata, "fileData": b"".join(data for _, data in output_files)}


def main() -> None:
    operation = sys.argv[1] if len(sys.argv) > 1 else ""
    try:
        if operation == "rebuild-yft-binary":
            payload = decode_binary_rebuild_bundle(sys.stdin.buffer.read())
        elif operation in {"preview-yft-binary", "inspect-yft-extras-binary"}:
            payload = decode_binary_preview_bundle(sys.stdin.buffer.read())
        else:
            payload = json.load(sys.stdin)
        if not isinstance(payload, dict):
            raise ValueError("Request body must be an object.")
        if operation == "decode-ytd":
            result = decode_ytd(payload)
        elif operation == "replace-ytd":
            result = replace_ytd(payload)
        elif operation == "inspect-yft-extras":
            result = inspect_yft_extras(payload)
        elif operation == "inspect-yft-extras-binary":
            result = {
                "fileName": payload["fileName"],
                "extras": vehicle_extra_parts(
                    list(Yft.from_bytes(payload["modelData"], path=payload["fileName"]).iter_drawables())
                ),
            }
        elif operation == "rebuild-yft-binary":
            result = rebuild_yft_binary(payload)
            metadata = json.dumps(result["metadata"], separators=(",", ":")).encode("utf-8")
            sys.stdout.buffer.write(struct.pack(">I", len(metadata)))
            sys.stdout.buffer.write(metadata)
            sys.stdout.buffer.write(result["fileData"])
            return
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
