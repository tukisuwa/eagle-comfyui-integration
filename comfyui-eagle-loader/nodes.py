"""
ComfyUI Eagle Loader Custom Nodes
Provides nodes to browse, search, and load images from Eagle library
"""

import server
from aiohttp import web
import aiohttp
import asyncio
import base64
import os
import requests
import json
from PIL import Image
from PIL.PngImagePlugin import PngInfo
import re
import numpy as np
import torch
import folder_paths
from urllib.parse import urlencode
import io

EAGLE_API_BASE = os.environ.get("EAGLE_BRIDGE_API_BASE", "http://127.0.0.1:8765/api")
EAGLE_BRIDGE_TOKEN = os.environ.get("EAGLE_BRIDGE_TOKEN", "")
EAGLE_LOADER_DEBUG = os.environ.get("EAGLE_LOADER_DEBUG", "").lower() in ("1", "true", "yes", "on")


def _loader_debug(message: str):
    if EAGLE_LOADER_DEBUG:
        print(message)


def _bridge_headers() -> dict:
    headers = {}
    if EAGLE_BRIDGE_TOKEN:
        headers["Authorization"] = f"Bearer {EAGLE_BRIDGE_TOKEN}"
    return headers


def _normalize_tags(tags: str) -> str:
    if not tags:
        return ""
    return ",".join([t.strip() for t in tags.split(",") if t.strip()])


def _build_folder_path_map(folders: list):
    by_id = {}
    for f in folders or []:
        if not isinstance(f, dict):
            continue
        fid = f.get("id")
        if fid is None:
            continue
        by_id[str(fid)] = f

    cache = {}

    def path_for(folder_id, depth=0):
        fid = str(folder_id)
        if fid in cache:
            return cache[fid]
        folder = by_id.get(fid)
        if not folder:
            cache[fid] = fid
            return fid
        if depth > 50:
            name = folder.get("name") or fid
            cache[fid] = name
            return name
        name = folder.get("name") or fid
        parent_id = folder.get("parent")
        if parent_id and str(parent_id) in by_id:
            path_value = f"{path_for(parent_id, depth + 1)}/{name}"
        else:
            path_value = name
        cache[fid] = path_value
        return path_value

    return path_for, by_id


def _extract_folder_id(folder_value: str, folders: list):
    if not folder_value or folder_value == "All":
        return None
    value = str(folder_value).strip()
    if not value:
        return None

    match = re.search(r"\[([^\[\]]+)\]\s*$", value)
    if match:
        return match.group(1).strip()

    path_for, by_id = _build_folder_path_map(folders or [])

    if value in by_id:
        return value

    for fid, folder in by_id.items():
        if value == path_for(fid):
            return fid

    matches = [fid for fid, folder in by_id.items() if (folder.get("name") or "") == value]
    if len(matches) == 1:
        return matches[0]

    return None


NODE_DIR = os.path.dirname(os.path.abspath(__file__))
UI_STATE_FILE = os.path.join(NODE_DIR, "eagle_gallery_ui_state.json")


def _load_ui_state():
    if not os.path.exists(UI_STATE_FILE):
        return {}
    try:
        with open(UI_STATE_FILE, "r", encoding="utf-8") as file_handle:
            return json.load(file_handle)
    except Exception:
        return {}


def _save_ui_state(data):
    try:
        with open(UI_STATE_FILE, "w", encoding="utf-8") as file_handle:
            json.dump(data, file_handle, indent=2, ensure_ascii=False)
    except Exception:
        pass


async def _proxy_json_get(path_suffix: str, query: dict):
    target_url = f"{EAGLE_API_BASE}/{path_suffix.lstrip('/')}"
    timeout = aiohttp.ClientTimeout(total=10)
    headers = {}
    if EAGLE_BRIDGE_TOKEN:
        headers["Authorization"] = f"Bearer {EAGLE_BRIDGE_TOKEN}"
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.get(target_url, params=query, headers=headers) as response:
            text = await response.text()
            try:
                payload = json.loads(text) if text else {}
            except Exception:
                payload = {"error": "Invalid JSON from Eagle Bridge"}
            return response.status, payload


async def _proxy_json_post(path_suffix: str, query: dict, body: dict):
    target_url = f"{EAGLE_API_BASE}/{path_suffix.lstrip('/')}"
    timeout = aiohttp.ClientTimeout(total=10)
    headers = {}
    if EAGLE_BRIDGE_TOKEN:
        headers["Authorization"] = f"Bearer {EAGLE_BRIDGE_TOKEN}"
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.post(target_url, params=query, json=body, headers=headers) as response:
            text = await response.text()
            try:
                payload = json.loads(text) if text else {}
            except Exception:
                payload = {"error": "Invalid JSON from Eagle Bridge"}
            return response.status, payload


async def _proxy_bytes_get(path_suffix: str, query: dict, request_headers):
    target_url = f"{EAGLE_API_BASE}/{path_suffix.lstrip('/')}"
    debug_thumb = query.get("debug") in ("1", "true", "True")
    debug_rid = query.get("rid", "")
    timeout = aiohttp.ClientTimeout(total=30)
    headers = {}
    if EAGLE_BRIDGE_TOKEN:
        headers["Authorization"] = f"Bearer {EAGLE_BRIDGE_TOKEN}"
    if request_headers and request_headers.get("If-None-Match"):
        headers["If-None-Match"] = request_headers.get("If-None-Match")

    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.get(target_url, params=query, headers=headers) as response:
            body = await response.read()
            passthrough = {}
            for header_name in ["Content-Type", "Cache-Control", "ETag", "Last-Modified", "X-Eagle-Item-Id", "X-Eagle-Thumbnail-Path", "X-Eagle-Served-Path", "X-Eagle-Served-Source", "X-Eagle-Thumbnail-Mismatch", "X-Eagle-Request-Id", "Content-Length"]:
                value = response.headers.get(header_name)
                if value:
                    passthrough[header_name] = value
            if debug_thumb:
                print(
                    "[Eagle Gallery Thumb Proxy] "
                    f"rid={debug_rid} path={path_suffix} id={query.get('id', '')} "
                    f"status={response.status} bytes={len(body)} "
                    f"content_type={response.headers.get('Content-Type', '')} "
                    f"item_id={response.headers.get('X-Eagle-Item-Id', '')} "
                    f"thumb_path={response.headers.get('X-Eagle-Thumbnail-Path', '')} "
                    f"served_path={response.headers.get('X-Eagle-Served-Path', '')} "
                    f"served_source={response.headers.get('X-Eagle-Served-Source', '')} "
                    f"mismatch={response.headers.get('X-Eagle-Thumbnail-Mismatch', '')}"
                )
            return response.status, body, passthrough


def _load_image_via_bridge(item_id: str) -> Image.Image:
    url = f"{EAGLE_API_BASE}/image"
    headers = {}
    if EAGLE_BRIDGE_TOKEN:
        headers["Authorization"] = f"Bearer {EAGLE_BRIDGE_TOKEN}"
    response = requests.get(url, params={"id": item_id}, headers=headers, timeout=30)
    response.raise_for_status()
    with Image.open(io.BytesIO(response.content)) as img:
        return img.convert("RGB")


def _load_bytes_via_bridge(item_id: str, debug: bool = False, rid: str = "") -> bytes:
    url = f"{EAGLE_API_BASE}/image"
    headers = {}
    if EAGLE_BRIDGE_TOKEN:
        headers["Authorization"] = f"Bearer {EAGLE_BRIDGE_TOKEN}"
    params = {"id": item_id}
    if debug:
        params["debug"] = "1"
        params["rid"] = rid
    response = requests.get(url, params=params, headers=headers, timeout=60)
    response.raise_for_status()
    if debug:
        print(
            "[Eagle LoadWF Bridge Image] "
            f"rid={rid} id={item_id} status={response.status_code} bytes={len(response.content)} "
            f"content_type={response.headers.get('Content-Type', '')} "
            f"item_id={response.headers.get('X-Eagle-Item-Id', '')} "
            f"file_path={response.headers.get('X-Eagle-File-Path', '')}"
        )
    return response.content


def _path_belongs_to_item_info(file_path: str, item_id: str) -> bool:
    if not file_path or not item_id:
        return False
    normalized = str(file_path).replace("\\", "/").lower()
    return f"/{str(item_id).lower()}.info/" in normalized


def _load_item_bytes(item: dict, debug: bool = False, rid: str = "") -> tuple[bytes, dict]:
    file_path = item.get("filePath")
    item_id = item.get("id")
    if file_path and isinstance(file_path, str) and (not item_id or _path_belongs_to_item_info(file_path, str(item_id))):
        try:
            if os.path.exists(file_path):
                with open(file_path, "rb") as fh:
                    data = fh.read()
                source = {"kind": "local_filePath", "filePath": file_path, "bytes": len(data)}
                if debug:
                    print(f"[Eagle LoadWF Bytes] rid={rid} id={item_id} source=local_filePath file_path={file_path} bytes={len(data)}")
                return data, source
        except Exception as e:
            if debug:
                print(f"[Eagle LoadWF Bytes] rid={rid} id={item_id} local_read_error={e} file_path={file_path}")
            pass

    if not item_id:
        raise RuntimeError("Missing item id for remote load")
    data = _load_bytes_via_bridge(str(item_id), debug=debug, rid=rid)
    source = {"kind": "bridge_image", "filePath": file_path or "", "bytes": len(data)}
    if debug:
        print(f"[Eagle LoadWF Bytes] rid={rid} id={item_id} source=bridge_image bytes={len(data)} stale_file_path={file_path or ''}")
    return data, source


def _try_parse_json(value):
    if value is None:
        return None, False
    if isinstance(value, (dict, list, int, float, bool)):
        return value, True
    if not isinstance(value, str):
        try:
            value = value.decode("utf-8", errors="replace")
        except Exception:
            value = str(value)
    text = value.strip()
    if not text:
        return "", True
    if not (text.startswith("{") or text.startswith("[") or text in ("true", "false", "null")):
        return value, False
    try:
        return json.loads(text), True
    except Exception:
        return value, False


def _extract_comfyui_embedded_metadata(image_bytes: bytes) -> dict:
    """
    Extract ComfyUI embedded metadata from an image (typically PNG).
    ComfyUI SaveImage embeds:
      - "prompt": JSON string
      - keys from extra_pnginfo (notably "workflow"): JSON strings
    """
    info_raw = {}
    parsed = {}
    has_any = False

    with Image.open(io.BytesIO(image_bytes)) as img:
        info = getattr(img, "info", {}) or {}
        for k, v in info.items():
            info_raw[str(k)] = v if isinstance(v, str) else (v.decode("utf-8", errors="replace") if isinstance(v, (bytes, bytearray)) else str(v))

    for key, raw_value in info_raw.items():
        value, ok = _try_parse_json(raw_value)
        if ok:
            parsed[key] = value
            has_any = True

    workflow = parsed.get("workflow")
    prompt_obj = parsed.get("prompt")
    return {
        "has_embedded": bool(has_any),
        "has_workflow": isinstance(workflow, (dict, list)),
        "workflow": workflow,
        "prompt": prompt_obj,
        "raw": info_raw,
        "parsed": parsed,
    }

def _load_rgb_image_from_item(item: dict) -> Image.Image:
    file_path = item.get("filePath")
    item_id = item.get("id")
    if file_path and (not item_id or _path_belongs_to_item_info(str(file_path), str(item_id))):
        try:
            with Image.open(file_path) as img:
                return img.convert("RGB")
        except Exception:
            pass

    if not item_id:
        raise RuntimeError("Missing item id for remote load")
    return _load_image_via_bridge(str(item_id))


prompt_server = server.PromptServer.instance


@prompt_server.routes.get("/eagle_gallery/ping")
async def eagle_gallery_ping(request):
    return web.json_response({"status": "ok"})


@prompt_server.routes.get("/eagle_gallery/events")
async def eagle_gallery_events(request):
    """Proxy Eagle Bridge SSE events to the browser without exposing the Eagle token."""
    target_url = f"{EAGLE_API_BASE}/events"
    timeout = aiohttp.ClientTimeout(total=None, sock_read=None)
    headers = {}
    if EAGLE_BRIDGE_TOKEN:
        headers["Authorization"] = f"Bearer {EAGLE_BRIDGE_TOKEN}"

    downstream = web.StreamResponse(
        status=200,
        headers={
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        },
    )
    await downstream.prepare(request)

    try:
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(target_url, headers=headers) as upstream:
                if upstream.status != 200:
                    text = await upstream.text()
                    msg = {"error": text or f"HTTP {upstream.status}"}
                    payload = "event: bridge_error\n" + "data: " + json.dumps(msg, ensure_ascii=False) + "\n\n"
                    await downstream.write(payload.encode("utf-8"))
                    return downstream

                async for chunk in upstream.content.iter_chunked(1024):
                    try:
                        await downstream.write(chunk)
                    except (ConnectionResetError, BrokenPipeError):
                        break
    except Exception as e:
        try:
            payload = "event: bridge_error\n" + "data: " + json.dumps({"error": str(e)}, ensure_ascii=False) + "\n\n"
            await downstream.write(payload.encode("utf-8"))
        except Exception:
            pass
    finally:
        try:
            await downstream.write_eof()
        except Exception:
            pass

    return downstream


@prompt_server.routes.get("/eagle_gallery/search")
async def eagle_gallery_search(request):
    try:
        status, payload = await _proxy_json_get("/search", dict(request.query))
        return web.json_response(payload, status=status)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=502)


@prompt_server.routes.get("/eagle_gallery/thumbnail")
async def eagle_gallery_thumbnail(request):
    try:
        status, payload = await _proxy_json_get("/thumbnail", dict(request.query))
        return web.json_response(payload, status=status)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=502)


@prompt_server.routes.get("/eagle_gallery/thumbnail_image")
async def eagle_gallery_thumbnail_image(request):
    try:
        status, body, headers = await _proxy_bytes_get("/thumbnail_image", dict(request.query), request.headers)
        if status == 304:
            return web.Response(status=304, headers=headers)
        return web.Response(body=body, status=status, headers=headers)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=502)


@prompt_server.routes.get("/eagle_gallery/get_image")
async def eagle_gallery_get_image(request):
    try:
        status, payload = await _proxy_json_get("/get_image", dict(request.query))
        return web.json_response(payload, status=status)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=502)


@prompt_server.routes.get("/eagle_gallery/image")
async def eagle_gallery_image(request):
    try:
        status, body, headers = await _proxy_bytes_get("/image", dict(request.query), request.headers)
        if status == 304:
            return web.Response(status=304, headers=headers)
        return web.Response(body=body, status=status, headers=headers)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=502)


@prompt_server.routes.get("/eagle_gallery/folders")
async def eagle_gallery_folders(request):
    try:
        status, payload = await _proxy_json_get("/folders", dict(request.query))
        return web.json_response(payload, status=status)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=502)


@prompt_server.routes.get("/eagle_gallery/tags")
async def eagle_gallery_tags(request):
    try:
        status, payload = await _proxy_json_get("/tags", dict(request.query))
        return web.json_response(payload, status=status)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=502)


@prompt_server.routes.post("/eagle_gallery/set_ui_state")
async def eagle_gallery_set_ui_state(request):
    try:
        data = await request.json()
        node_id = str(data.get("node_id", ""))
        state = data.get("state", None)
        if not node_id or state is None:
            return web.json_response({"status": "error", "message": "Missing required data"}, status=400)

        ui_states = _load_ui_state()
        ui_states[node_id] = state
        _save_ui_state(ui_states)
        return web.json_response({"status": "ok"})
    except Exception as e:
        return web.json_response({"status": "error", "message": str(e)}, status=500)


@prompt_server.routes.post("/eagle_gallery/open")
async def eagle_gallery_open(request):
    try:
        payload = {}
        try:
            payload = await request.json()
        except Exception:
            payload = {}
        item_id = payload.get("id") or payload.get("itemId") or request.query.get("id") or ""
        status, out = await _proxy_json_post("/open", dict(request.query), {"id": item_id})
        return web.json_response(out, status=status)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=502)


@prompt_server.routes.post("/eagle_gallery/update_item")
async def eagle_gallery_update_item(request):
    try:
        payload = {}
        try:
            payload = await request.json()
        except Exception:
            payload = {}
        status, out = await _proxy_json_post("/update_item", dict(request.query), payload)
        return web.json_response(out, status=status)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=502)


@prompt_server.routes.post("/eagle_gallery/folder_delete")
async def eagle_gallery_folder_delete(request):
    try:
        payload = {}
        try:
            payload = await request.json()
        except Exception:
            payload = {}
        status, out = await _proxy_json_post("/folder_delete", dict(request.query), payload)
        return web.json_response(out, status=status)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=502)


@prompt_server.routes.get("/eagle_gallery/workflow_metadata")
async def eagle_gallery_workflow_metadata(request):
    """
    Returns embedded ComfyUI metadata (workflow/prompt/etc) extracted from the item's image file.
    Prefers local filePath when accessible, otherwise fetches bytes via Eagle Bridge /api/image.
    """
    try:
        item_id = request.query.get("id", "")
        debug = request.query.get("debug") in ("1", "true", "True")
        rid = request.query.get("rid", "")
        if not item_id:
            return web.json_response({"error": "Missing item ID"}, status=400)

        get_image_query = {"id": item_id}
        if debug:
            get_image_query["debug"] = "1"
            get_image_query["rid"] = rid
        status, item_payload = await _proxy_json_get("/get_image", get_image_query)
        if status != 200:
            return web.json_response(item_payload, status=status)

        item = item_payload or {}
        item["id"] = item_id

        if debug:
            print(
                "[Eagle LoadWF Item] "
                f"rid={rid} id={item_id} name={item.get('name', '')} "
                f"filePath={item.get('filePath', '')} ext={item.get('ext', '')} "
                f"width={item.get('width', '')} height={item.get('height', '')}"
            )
        image_bytes, source = _load_item_bytes(item, debug=debug, rid=rid)
        meta = _extract_comfyui_embedded_metadata(image_bytes)
        parsed_keys = sorted(list((meta.get("parsed") or {}).keys()))
        if debug:
            print(
                "[Eagle LoadWF Metadata] "
                f"rid={rid} id={item_id} bytes={len(image_bytes)} "
                f"source={source.get('kind', '')} filePath={source.get('filePath', '')} "
                f"has_embedded={bool(meta.get('has_embedded'))} has_workflow={bool(meta.get('has_workflow'))} "
                f"parsed_keys={parsed_keys} raw_keys={sorted(list((meta.get('raw') or {}).keys()))}"
            )
        return web.json_response(
            {
                "ok": True,
                "id": str(item_id),
                "has_workflow": bool(meta.get("has_workflow")),
                "workflow": meta.get("workflow"),
                "prompt": meta.get("prompt"),
                "parsed_keys": parsed_keys,
                "source": source,
            }
        )
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=502)

@prompt_server.routes.get("/eagle_gallery/get_ui_state")
async def eagle_gallery_get_ui_state(request):
    try:
        node_id = request.query.get("node_id", "")
        if not node_id:
            return web.json_response({})
        ui_states = _load_ui_state()
        return web.json_response(ui_states.get(str(node_id), {}))
    except Exception as e:
        return web.json_response({"status": "error", "message": str(e)}, status=500)


class EagleImageBrowser:
    """Browse and load images from Eagle library"""
    
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "search_query": ("STRING", {
                    "default": "", 
                    "multiline": False,
                    "placeholder": "Search keywords..."
                }),
            },
            "optional": {
                "tags_filter": ("STRING", {
                    "default": "", 
                    "multiline": False,
                    "placeholder": "tag1,tag2,tag3"
                }),
                "folder_filter": (["All"] + cls.get_eagle_folders(), ),
                "min_rating": ("INT", {
                    "default": 0,
                    "min": 0,
                    "max": 5,
                    "step": 1
                }),
                "selected_index": ("INT", {
                    "default": 0,
                    "min": 0,
                    "max": 0xffffffffffffffff,
                    "step": 1
                }),
                "selected_item_json": ("STRING", {
                    "default": "",
                    "multiline": True,
                }),
                "index_overflow": (["placeholder", "loop", "error"], {
                    "default": "loop",
                }),
                "index_mode": (["fixed", "increment", "decrement", "random"], {
                    "default": "fixed",
                }),
            }
        }
    
    RETURN_TYPES = ("IMAGE", "STRING", "STRING")
    RETURN_NAMES = ("image", "file_path", "metadata_json")
    FUNCTION = "load_from_eagle"
    CATEGORY = "Eagle"
    
    @classmethod
    def get_eagle_folders(cls):
        """Get list of folders from Eagle"""
        try:
            response = requests.get(f"{EAGLE_API_BASE}/folders", headers=_bridge_headers(), timeout=2)
            if response.ok:
                folders = response.json().get('folders', [])
                path_for, _ = _build_folder_path_map(folders)
                options = []
                for folder in folders:
                    if not isinstance(folder, dict):
                        continue
                    folder_id = folder.get("id")
                    if folder_id is None:
                        continue
                    folder_path = path_for(folder_id)
                    options.append(f"{folder_path} [{folder_id}]")
                return sorted(options, key=lambda v: str(v).lower())
        except:
            pass
        return []
    
    @classmethod
    def get_eagle_search_payload(cls, search_query="", tags="", folder=None, limit=20, offset=0, min_rating=0):
        """Search Eagle library"""
        params = {
            'q': search_query,
            'limit': limit,
            'offset': offset,
        }
        
        tags = _normalize_tags(tags)
        if tags:
            params["tags"] = tags
        min_rating = int(min_rating or 0)
        if min_rating > 0:
            params["min_rating"] = min_rating
        
        if folder and folder != "All":
            try:
                folders_response = requests.get(f"{EAGLE_API_BASE}/folders", headers=_bridge_headers(), timeout=2)
                if folders_response.ok:
                    folders = folders_response.json().get('folders', [])
                    folder_id = _extract_folder_id(folder, folders)
                    if folder_id:
                        params["folder"] = folder_id
            except:
                pass

        try:
            response = requests.get(
                f"{EAGLE_API_BASE}/search",
                params=params,
                headers=_bridge_headers(),
                timeout=5,
            )
            if response.ok:
                return response.json()
        except Exception as e:
            print(f"[Eagle Loader] API Error: {e}")
        
        return {"results": [], "total": 0}

    @classmethod
    def get_eagle_results(cls, search_query="", tags="", folder=None, limit=20, offset=0, min_rating=0):
        """Search Eagle library and return result list."""
        return cls.get_eagle_search_payload(
            search_query=search_query,
            tags=tags,
            folder=folder,
            limit=limit,
            offset=offset,
            min_rating=min_rating,
        ).get("results", [])

    @staticmethod
    def _normalize_index_mode(index_mode):
        value = str(index_mode or "fixed").lower()
        return value if value in {"fixed", "increment", "decrement", "random"} else "fixed"

    @staticmethod
    def _next_index(current_index, total_results, index_mode, index_overflow):
        current_index = max(0, int(current_index or 0))
        total_results = int(total_results or 0)
        if total_results <= 0 or index_mode == "fixed":
            return current_index
        if index_mode == "increment":
            next_index = current_index + 1
            return next_index % total_results if index_overflow == "loop" else next_index
        if index_mode == "decrement":
            next_index = current_index - 1
            if next_index < 0:
                return total_results - 1 if index_overflow == "loop" else 0
            return next_index
        if index_mode == "random":
            import random
            return random.randint(0, total_results - 1)
        return current_index

    @classmethod
    def _with_next_index_ui(cls, result, current_index, total_results, index_mode, index_overflow):
        if index_mode == "fixed":
            return result
        next_index = cls._next_index(current_index, total_results, index_mode, index_overflow)
        return {
            "result": result,
            "ui": {
                "selected_index": [next_index],
                "selected_item_json": [""],
            },
        }
    
    def load_from_eagle(self, search_query, tags_filter="", folder_filter="All", min_rating=0, selected_index=0, selected_item_json="", index_overflow="loop", index_mode="fixed", limit=None):
        """Load image from Eagle library"""

        index_mode = self._normalize_index_mode(index_mode)
        index_overflow = str(index_overflow or "loop").lower()
        if index_overflow not in {"placeholder", "loop", "error"}:
            index_overflow = "loop"

        if selected_item_json and index_mode == "fixed":
            try:
                item = json.loads(selected_item_json)
                json_index = item.get("_eagle_selected_index") if isinstance(item, dict) else None
                selected_index_int = int(selected_index or 0)
                _loader_debug(
                    "[Eagle Loader] selected_item_json "
                    f"id={item.get('id') if isinstance(item, dict) else ''} "
                    f"name={item.get('name') if isinstance(item, dict) else ''} "
                    f"json_index={json_index} selected_index={selected_index_int} "
                    f"has_filePath={bool(item.get('filePath')) if isinstance(item, dict) else False}"
                )
                if isinstance(item, dict) and item.get("filePath") and json_index is not None and int(json_index) == selected_index_int:
                    return self._load_item(item, selected_index_int, max(selected_index_int + 1, 1))
            except Exception:
                pass
        
        # Search Eagle
        requested_index = max(0, int(selected_index or 0))
        selected_index = requested_index
        payload = self.get_eagle_search_payload(
            search_query=search_query,
            tags=tags_filter,
            folder=folder_filter,
            limit=1,
            offset=selected_index,
            min_rating=min_rating
        )
        results = payload.get("results", [])
        total_results = int(payload.get("total") or len(results) or 0)
        _loader_debug(
            "[Eagle Loader] search "
            f"q={search_query!r} tags={tags_filter!r} folder={folder_filter!r} "
            f"min_rating={min_rating} selected_index={selected_index} "
            f"results={len(results)} total={total_results}"
        )
        
        if not results:
            if total_results > 0 and selected_index >= total_results:
                if index_overflow == "loop":
                    selected_index = selected_index % total_results
                    payload = self.get_eagle_search_payload(
                        search_query=search_query,
                        tags=tags_filter,
                        folder=folder_filter,
                        limit=1,
                        offset=selected_index,
                        min_rating=min_rating
                    )
                    results = payload.get("results", [])
                    total_results = int(payload.get("total") or total_results)
                    if results:
                        item = results[0]
                        result = self._load_item(item, selected_index, total_results, requested_index=requested_index, index_overflow=index_overflow, index_mode=index_mode)
                        if index_mode == "fixed":
                            return {"result": result, "ui": {"selected_index": [selected_index], "selected_item_json": [""]}}
                        return self._with_next_index_ui(result, selected_index, total_results, index_mode, index_overflow)
                if index_overflow == "error":
                    raise IndexError(f"Eagle selected_index out of range: {requested_index} >= {total_results}")
                message = f"selected_index out of range: {requested_index} >= {total_results}"
                print(f"[Eagle Loader] {message}")
                metadata = {
                    "error": message,
                    "index": selected_index,
                    "requested_index": requested_index,
                    "total_results": total_results,
                    "index_overflow": index_overflow,
                }
                return self.create_placeholder(), "", json.dumps(metadata, ensure_ascii=False)

            print("[Eagle Loader] No results found")
            return self.create_placeholder(), "", json.dumps({"error": "No results found", "total_results": total_results}, ensure_ascii=False)

        item = results[0]
        
        # Load image
        result = self._load_item(item, selected_index, total_results, requested_index=requested_index, index_overflow=index_overflow, index_mode=index_mode)
        return self._with_next_index_ui(result, selected_index, total_results, index_mode, index_overflow)

    def _load_item(self, item, selected_index, total_results, requested_index=None, index_overflow="placeholder", index_mode="fixed"):
        try:
            _loader_debug(
                "[Eagle Loader] load_item "
                f"id={item.get('id', '')} name={item.get('name', '')} "
                f"index={selected_index} total={total_results} "
                f"filePath={item.get('filePath', '')} "
                f"keys={sorted(list(item.keys())) if isinstance(item, dict) else []}"
            )
            img = _load_rgb_image_from_item(item)
             
            # Convert to tensor
            img_array = np.array(img).astype(np.float32) / 255.0
            img_tensor = torch.from_numpy(img_array)[None,]
            
            # Create metadata
            metadata = {
                'index': selected_index,
                'requested_index': selected_index if requested_index is None else requested_index,
                'index_overflow': index_overflow,
                'index_mode': EagleImageBrowser._normalize_index_mode(index_mode),
                'total_results': total_results,
                'name': item.get('name', ''),
                'id': item.get('id', ''),
                'tags': item.get('tags') or [],
                'annotation': item.get('annotation') or '',
                'width': item.get('width'),
                'height': item.get('height'),
                'star': item.get('star', 0),
                'ext': item.get('ext', '')
            }
            
            _loader_debug(f"[Eagle Loader] Loaded: {item.get('name', '')} ({selected_index + 1}/{total_results})")
            
            return (img_tensor, item.get("filePath", ""), json.dumps(metadata, ensure_ascii=False))
            
        except Exception as e:
            print(f"[Eagle Loader] Error loading image: {e}")
            return self.create_placeholder(), "", json.dumps({"error": str(e)})
    
    def create_placeholder(self):
        """Create a placeholder image"""
        img = np.zeros((512, 512, 3), dtype=np.float32)
        # Add some pattern
        img[::32, :] = 0.1
        img[:, ::32] = 0.1
        return torch.from_numpy(img)[None,]


class EagleImageByID:
    """Load a specific Eagle image by ID"""
    
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "item_id": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "placeholder": "Eagle item ID..."
                }),
            },
            "optional": {
                "eagle_id": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "placeholder": "Legacy alias for item_id"
                }),
            }
        }
    
    RETURN_TYPES = ("IMAGE", "STRING", "STRING")
    RETURN_NAMES = ("image", "file_path", "metadata_json")
    FUNCTION = "load_by_id"
    CATEGORY = "Eagle"
    
    def load_by_id(self, item_id, eagle_id=""):
        """Load image by Eagle item ID"""
        resolved_id = (item_id or "").strip() or (eagle_id or "").strip()
        
        if not resolved_id:
            return self.create_placeholder(), "", json.dumps({"error": "No ID provided"})
        
        try:
            # Get image details from Eagle
            response = requests.get(
                f"{EAGLE_API_BASE}/get_image",
                params={'id': resolved_id},
                headers=_bridge_headers(),
                timeout=5,
            )
            
            if not response.ok:
                return self.create_placeholder(), "", json.dumps({"error": "Item not found"})
            
            item = response.json()
            
            img = _load_rgb_image_from_item(item)
            
            img_array = np.array(img).astype(np.float32) / 255.0
            img_tensor = torch.from_numpy(img_array)[None,]
            
            metadata = {
                'name': item.get('name', ''),
                'id': item.get('id', resolved_id),
                'tags': item.get('tags') or [],
                'annotation': item.get('annotation') or '',
                'width': item.get('width'),
                'height': item.get('height'),
                'star': item.get('star', 0),
                'ext': item.get('ext', '')
            }
            
            print(f"[Eagle Loader] Loaded by ID: {item.get('name', resolved_id)}")
            
            return (img_tensor, item.get('filePath', ''), json.dumps(metadata, ensure_ascii=False))
            
        except Exception as e:
            print(f"[Eagle Loader] Error: {e}")
            return self.create_placeholder(), "", json.dumps({"error": str(e)})
    
    def create_placeholder(self):
        """Create a placeholder image"""
        img = np.zeros((512, 512, 3), dtype=np.float32)
        img[::32, :] = 0.1
        img[:, ::32] = 0.1
        return torch.from_numpy(img)[None,]


class EagleRandomImage:
    """Load a deterministic random image from Eagle library."""
    
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "optional": {
                "search_query": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "placeholder": "Search keywords..."
                }),
                "tags_filter": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "placeholder": "tag1,tag2"
                }),
                "folder_filter": (["All"] + EagleImageBrowser.get_eagle_folders(), ),
                "min_rating": ("INT", {
                    "default": 0,
                    "min": 0,
                    "max": 5,
                    "step": 1
                }),
                "seed": ("INT", {
                    "default": 0,
                    "min": 0,
                    "max": 0xffffffffffffffff
                }),
            }
        }
    
    RETURN_TYPES = ("IMAGE", "STRING", "STRING")
    RETURN_NAMES = ("image", "file_path", "metadata_json")
    FUNCTION = "load_random"
    CATEGORY = "Eagle"
    
    def load_random(self, search_query="", tags_filter="", folder_filter="All", min_rating=0, seed=0):
        """Load a random image"""
        tags_filter = _normalize_tags(tags_filter)

        payload = EagleImageBrowser.get_eagle_search_payload(
            search_query=search_query,
            tags=tags_filter,
            folder=folder_filter,
            limit=1,
            offset=0,
            min_rating=min_rating,
        )
        total_results = int(payload.get("total") or 0)

        if total_results <= 0:
            img = np.zeros((512, 512, 3), dtype=np.float32)
            message = "No results matching criteria" if min_rating > 0 or tags_filter else "No results"
            return (torch.from_numpy(img)[None,], "", json.dumps({
                "error": message,
                "total_results": total_results,
                "search_query": search_query,
                "tags": tags_filter,
                "folder_filter": folder_filter,
                "min_rating": int(min_rating or 0),
            }, ensure_ascii=False))

        import random
        rng = random.Random(int(seed or 0))
        selected_index = rng.randrange(total_results)

        payload = EagleImageBrowser.get_eagle_search_payload(
            search_query=search_query,
            tags=tags_filter,
            folder=folder_filter,
            limit=1,
            offset=selected_index,
            min_rating=min_rating,
        )
        results = payload.get("results", [])
        total_results = int(payload.get("total") or total_results)

        if not results:
            img = np.zeros((512, 512, 3), dtype=np.float32)
            return (torch.from_numpy(img)[None,], "", json.dumps({
                "error": "Random selection returned no item",
                "index": selected_index,
                "total_results": total_results,
                "search_query": search_query,
                "tags": tags_filter,
                "folder_filter": folder_filter,
                "min_rating": int(min_rating or 0),
            }, ensure_ascii=False))

        item = results[0]
        
        # Load image
        try:
            image, file_path, metadata_json = EagleImageBrowser()._load_item(
                item,
                selected_index,
                total_results,
                requested_index=selected_index,
                index_overflow="loop",
                index_mode="random",
            )
            try:
                metadata = json.loads(metadata_json)
            except Exception:
                metadata = {}
            metadata.update({
                'seed': seed,
                'search_query': search_query,
                'tags_filter': tags_filter,
                'folder_filter': folder_filter,
                'min_rating': int(min_rating or 0),
                'selection_mode': 'seeded_random',
            })
            return (image, file_path, json.dumps(metadata, ensure_ascii=False))
            
        except Exception as e:
            print(f"[Eagle Loader] Error: {e}")
            img = np.zeros((512, 512, 3), dtype=np.float32)
            return (torch.from_numpy(img)[None,], "", json.dumps({"error": str(e)}))


def _prompt_to_tags(prompt_text: str, prefix: str = "") -> list:
    if not isinstance(prompt_text, str) or not prompt_text.strip():
        return []

    # Remove weights like ":1.2" and basic grouping characters
    cleaned = prompt_text
    cleaned = re.sub(r":-?\d+(\.\d+)?", "", cleaned)
    parts = [p.strip() for p in cleaned.split(",") if p.strip()]
    return [prefix + re.sub(r"[()]", "", p).strip() for p in parts if re.sub(r"[()]", "", p).strip()]


def _parse_tags_csv(tags_csv: str) -> list:
    if not tags_csv:
        return []
    return [t.strip() for t in tags_csv.split(",") if t.strip()]


def _normalize_api_base(base_url: str) -> str:
    base = (base_url or "").strip().rstrip("/")
    if base.endswith("/api"):
        base = base[:-4]
    return base


def _guess_mime_from_ext(ext: str) -> str:
    ext = (ext or "").lower().lstrip(".")
    if ext in ("jpg", "jpeg"):
        return "image/jpeg"
    if ext == "png":
        return "image/png"
    if ext == "webp":
        return "image/webp"
    return "application/octet-stream"


def _select_send_method(send_method, file_path: str, auto_base64_max_mb: int) -> str:
    method = (send_method or "").strip()
    if not method.lower().startswith("auto"):
        return method

    try:
        max_mb = int(auto_base64_max_mb)
    except Exception:
        max_mb = 0

    if max_mb <= 0:
        return "addFromURL (pull)"

    try:
        size_bytes = os.path.getsize(file_path) if file_path else 0
    except Exception:
        size_bytes = 0

    if size_bytes > (max_mb * 1024 * 1024):
        return "addFromURL (pull)"
    return "addFromBase64 (push)"


def _eagle_request_json(method: str, url: str, token, json_body):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    timeout = 15
    if method == "GET":
        response = requests.get(url, headers=headers, timeout=timeout)
    else:
        response = requests.post(url, headers=headers, json=json_body, timeout=timeout)
    response.raise_for_status()
    return response.json()


def _eagle_native_find_or_create_folder(eagle_base_url: str, token, name_or_id: str) -> str:
    value = (name_or_id or "").strip()
    if not value:
        return ""

    base = _normalize_api_base(eagle_base_url)

    # 1) Attempt: folder/list and match by id or name (recursive)
    list_url = f"{base}/api/folder/list"
    if token:
        list_url += f"?token={requests.utils.quote(token, safe='')}"
    data = _eagle_request_json("GET", list_url, token, None)
    folders = data.get("data", data)

    found_id = None

    def walk(node):
        nonlocal found_id
        if found_id:
            return
        if isinstance(node, dict):
            if node.get("id") == value or node.get("name") == value:
                found_id = node.get("id")
                return
            children = node.get("children") or []
            for child in children:
                walk(child)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    walk(folders)
    if found_id:
        return found_id

    # 2) Create folder
    create_url = f"{base}/api/folder/create"
    payload = {"folderName": value}
    if token:
        payload["token"] = token
    created = _eagle_request_json("POST", create_url, token, payload)
    return (created.get("data") or {}).get("id", "")


class EagleBuildSendInfo:
    """
    Build a JSON "send info" payload for Eagle Send nodes.

    This node exists so you can flexibly assemble metadata/tags/annotation in your workflow,
    then feed it into a separate send node that accepts (image + info).
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "eagle_folder": ("STRING", {"default": "", "multiline": False}),
                "name": ("STRING", {"default": "", "multiline": False, "placeholder": "Optional display name in Eagle"}),
                "website": ("STRING", {"default": "", "multiline": False, "placeholder": "Optional source URL"}),
                "annotation": ("STRING", {"default": "", "multiline": True}),
                "tags_csv": ("STRING", {"default": "", "multiline": False, "placeholder": "tag1,tag2,tag3"}),
            },
            "optional": {
                "merge_meta_json": ("STRING", {"default": "", "multiline": True}),
                "memo": ("STRING", {"default": "", "multiline": True}),
                "comment_text": ("STRING", {"default": "", "multiline": True, "forceInput": True}),
                "comment1": ("STRING", {"default": "", "multiline": False, "forceInput": True}),
                "comment2": ("STRING", {"default": "", "multiline": False, "forceInput": True}),
                "comment3": ("STRING", {"default": "", "multiline": False, "forceInput": True}),
                "comment4": ("STRING", {"default": "", "multiline": False, "forceInput": True}),
                "positive": ("STRING", {"default": "", "forceInput": True}),
                "negative": ("STRING", {"default": "", "forceInput": True}),
                "include_positive_as_tags": ("BOOLEAN", {"default": False}),
                "include_negative_as_tags": ("BOOLEAN", {"default": False}),
                "include_extra_as_kv_tags": ("BOOLEAN", {"default": False}),
                "kv_tag_prefix": ("STRING", {"default": "", "multiline": False, "placeholder": "Optional prefix, e.g. meta:"}),
                "key1": ("STRING", {"default": "", "multiline": False}),
                "value1": ("STRING", {"default": "", "multiline": False}),
                "key2": ("STRING", {"default": "", "multiline": False}),
                "value2": ("STRING", {"default": "", "multiline": False}),
                "key3": ("STRING", {"default": "", "multiline": False}),
                "value3": ("STRING", {"default": "", "multiline": False}),
                "key4": ("STRING", {"default": "", "multiline": False}),
                "value4": ("STRING", {"default": "", "multiline": False}),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("eagle_meta_json",)
    FUNCTION = "build"
    CATEGORY = "Eagle"

    def build(
        self,
        eagle_folder,
        name,
        website,
        annotation,
        tags_csv,
        merge_meta_json="",
        memo="",
        comment_text="",
        comment1="",
        comment2="",
        comment3="",
        comment4="",
        positive="",
        negative="",
        include_positive_as_tags=False,
        include_negative_as_tags=False,
        include_extra_as_kv_tags=False,
        kv_tag_prefix="",
        key1="",
        value1="",
        key2="",
        value2="",
        key3="",
        value3="",
        key4="",
        value4="",
    ):
        base = {}
        if merge_meta_json:
            try:
                loaded = json.loads(merge_meta_json)
                if isinstance(loaded, dict):
                    base.update(loaded)
            except Exception:
                pass

        tags = []
        tags.extend(base.get("tags", []) if isinstance(base.get("tags", []), list) else [])
        tags.extend(_parse_tags_csv(tags_csv))
        if include_positive_as_tags and isinstance(positive, str) and positive.strip():
            tags.extend(_prompt_to_tags(positive))
        if include_negative_as_tags and isinstance(negative, str) and negative.strip():
            tags.extend(_prompt_to_tags(negative, prefix="n:"))
        tags = [t for t in tags if isinstance(t, str) and t.strip()]

        anno_parts = []
        if isinstance(base.get("annotation"), str) and base.get("annotation").strip():
            anno_parts.append(base.get("annotation").strip())
        if isinstance(annotation, str) and annotation.strip():
            anno_parts.append(annotation.strip())
        if isinstance(comment_text, str) and comment_text.strip():
            anno_parts.append(comment_text.strip())
        for c in (comment1, comment2, comment3, comment4):
            if isinstance(c, str) and c.strip():
                anno_parts.append(c.strip())
        if isinstance(memo, str) and memo.strip():
            anno_parts.append("Memo: " + memo.strip())
        annotation_final = "\n".join(anno_parts)

        extra = {}
        extra.update(base.get("extra", {}) if isinstance(base.get("extra", {}), dict) else {})
        for k, v in ((key1, value1), (key2, value2), (key3, value3), (key4, value4)):
            if isinstance(k, str) and k.strip() and isinstance(v, str) and v.strip():
                extra[k.strip()] = v

        if include_extra_as_kv_tags and extra:
            prefix = kv_tag_prefix.strip() if isinstance(kv_tag_prefix, str) else ""
            for k, v in extra.items():
                if k is None or v is None:
                    continue
                k_str = str(k).strip()
                v_str = str(v).strip()
                if not k_str or not v_str:
                    continue
                tags.append(f"{prefix}{k_str}:{v_str}")
            tags = [t for t in tags if isinstance(t, str) and t.strip()]

        out = dict(base)
        if isinstance(eagle_folder, str) and eagle_folder.strip():
            out["folder"] = eagle_folder.strip()
        if isinstance(name, str) and name.strip():
            out["name"] = name.strip()
        if isinstance(website, str) and website.strip():
            out["website"] = website.strip()
        if tags:
            out["tags"] = tags
        if annotation_final:
            out["annotation"] = annotation_final
        if extra:
            out["extra"] = extra

        return (json.dumps(out, ensure_ascii=False),)


class EagleBuildSendInfoSimple:
    """Build a minimal Eagle send metadata JSON payload."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "eagle_folder": ("STRING", {"default": "", "multiline": False}),
                "name": ("STRING", {"default": "", "multiline": False, "placeholder": "Optional display name in Eagle"}),
                "annotation": ("STRING", {"default": "", "multiline": True}),
                "tags_csv": ("STRING", {"default": "", "multiline": False, "placeholder": "tag1,tag2,tag3"}),
            },
            "optional": {
                "website": ("STRING", {"default": "", "multiline": False, "placeholder": "Optional source URL"}),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("eagle_meta_json",)
    FUNCTION = "build"
    CATEGORY = "Eagle"

    def build(self, eagle_folder, name, annotation, tags_csv, website=""):
        return EagleBuildSendInfo().build(
            eagle_folder=eagle_folder,
            name=name,
            website=website,
            annotation=annotation,
            tags_csv=tags_csv,
        )


class EagleSendToEagle:
    """
    Save images to ComfyUI output and send them to Eagle.

    Designed for split environments: Eagle fetches the image from ComfyUI via addFromURL.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "send_target": (["Eagle Bridge Plugin", "Eagle Native API"],),
                "send_method": (["Auto (size-based)", "addFromURL (pull)", "addFromBase64 (push)"],),
                "eagle_base_url": ("STRING", {"default": "http://127.0.0.1:8765", "multiline": False}),
                "eagle_token": ("STRING", {"default": "", "multiline": False}),
                "eagle_folder": ("STRING", {"default": "", "multiline": False}),
                "comfyui_public_url": ("STRING", {"default": "http://127.0.0.1:8188", "multiline": False}),
                "file_format": (["png", "jpeg", "webp"],),
                "lossless_webp": ("BOOLEAN", {"default": True, "label_on": "lossless", "label_off": "lossy"}),
                "quality": ("INT", {"default": 95, "min": 1, "max": 100}),
                "auto_base64_max_mb": ("INT", {"default": 1, "min": 1, "max": 512}),
                "save_prompt_tags": ("BOOLEAN", {"default": True}),
                "save_negative_prompt_tags": ("BOOLEAN", {"default": False}),
                "extra_tags_csv": ("STRING", {"default": "source:comfyui", "multiline": False}),
            },
            "optional": {
                "eagle_meta_json": ("STRING", {"default": "", "multiline": True, "forceInput": True}),
                "memo": ("STRING", {"multiline": True}),
                "positive": ("STRING", {"default": "", "forceInput": True}),
                "negative": ("STRING", {"default": "", "forceInput": True}),
            },
            "hidden": {"prompt": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO"},
        }

    RETURN_TYPES = ("STRING", "IMAGE")
    RETURN_NAMES = ("send_result_json", "images")
    FUNCTION = "send"
    OUTPUT_NODE = True
    CATEGORY = "Eagle"

    def send(
        self,
        images,
        send_target,
        send_method,
        eagle_base_url,
        eagle_token,
        eagle_folder,
        comfyui_public_url,
        file_format,
        lossless_webp,
        quality,
        auto_base64_max_mb,
        save_prompt_tags,
        save_negative_prompt_tags,
        extra_tags_csv,
        eagle_meta_json="",
        memo="",
        positive="",
        negative="",
        prompt=None,
        extra_pnginfo=None,
    ):
        output_dir = folder_paths.get_output_directory()
        img_tensors = images
        batch_size = int(img_tensors.shape[0]) if hasattr(img_tensors, "shape") and len(img_tensors.shape) >= 4 else 1

        results = []

        parsed_meta = None
        if eagle_meta_json:
            try:
                parsed_meta = json.loads(eagle_meta_json)
            except Exception:
                parsed_meta = None

        for index in range(batch_size):
            meta_for_image = {}
            if isinstance(parsed_meta, dict):
                meta_for_image = parsed_meta
            elif isinstance(parsed_meta, list) and index < len(parsed_meta) and isinstance(parsed_meta[index], dict):
                meta_for_image = parsed_meta[index]

            image_tensor = img_tensors[index] if hasattr(img_tensors, "shape") and len(img_tensors.shape) >= 4 else img_tensors
            image_array = image_tensor.cpu().numpy() if hasattr(image_tensor, "cpu") else np.asarray(image_tensor)
            while image_array.ndim > 3 and image_array.shape[0] == 1:
                image_array = image_array[0]
            if image_array.ndim != 3:
                raise ValueError(f"Expected image tensor with shape HxWxC, got {tuple(image_array.shape)}")
            image_uint8 = np.clip(255.0 * image_array, 0, 255).astype(np.uint8)
            img = Image.fromarray(image_uint8)

            # ComfyUI expects output images to be in output dir, served via /api/view.
            prefix = "EagleSend"
            full_output_folder, filename, counter, subfolder, _ = folder_paths.get_save_image_path(
                prefix, output_dir, img.width, img.height
            )
            os.makedirs(full_output_folder, exist_ok=True)
            base_filename = f"{filename}_{counter:05}_"
            if batch_size >= 2:
                base_filename += f"({index})"
            ext = "jpg" if file_format == "jpeg" else file_format
            file_name = f"{base_filename}.{ext}"
            file_path = os.path.join(full_output_folder, file_name)

            # Save image (embed workflow/prompt only for PNG)
            if file_format == "png":
                pnginfo = PngInfo()
                if prompt is not None:
                    pnginfo.add_text("prompt", json.dumps(prompt))
                if extra_pnginfo is not None:
                    for k in extra_pnginfo:
                        pnginfo.add_text(k, json.dumps(extra_pnginfo[k]))
                img.save(file_path, pnginfo=pnginfo, compress_level=4)
            else:
                if file_format == "webp":
                    img.save(
                        file_path,
                        quality=quality,
                        lossless=bool(lossless_webp),
                    )
                else:
                    img.save(
                        file_path,
                        optimize=True,
                        quality=quality,
                    )

            # Build URL that Eagle will fetch
            query = urlencode({"filename": file_name, "type": "output", "subfolder": subfolder})
            file_url = f"{comfyui_public_url.rstrip('/')}/api/view?{query}"

            # Build tags
            tags = []
            tags.extend(_parse_tags_csv(extra_tags_csv))
            if save_prompt_tags and isinstance(positive, str) and positive.strip():
                tags.extend(_prompt_to_tags(positive))
            if save_negative_prompt_tags and isinstance(negative, str) and negative.strip():
                tags.extend(_prompt_to_tags(negative, prefix="n:"))
            if isinstance(meta_for_image.get("tags"), list):
                tags.extend([t for t in meta_for_image.get("tags") if isinstance(t, str) and t.strip()])
            tags = [t for t in tags if t]

            # Build annotation
            annotation_parts = []
            if isinstance(meta_for_image.get("annotation"), str) and meta_for_image.get("annotation").strip():
                annotation_parts.append(meta_for_image.get("annotation").strip())
            elif isinstance(positive, str) and positive.strip():
                annotation_parts.append(positive.strip())
            if isinstance(negative, str) and negative.strip():
                annotation_parts.append("Negative prompt: " + negative.strip())
            if isinstance(memo, str) and memo.strip():
                annotation_parts.append("Memo: " + memo.strip())

            extra_block = meta_for_image.get("extra")
            if isinstance(extra_block, dict) and extra_block:
                for k, v in extra_block.items():
                    if k is None or v is None:
                        continue
                    k_str = str(k).strip()
                    v_str = str(v).strip()
                    if k_str and v_str:
                        annotation_parts.append(f"{k_str}: {v_str}")
            annotation = "\n".join(annotation_parts)

            folder_value = meta_for_image.get("folder") if isinstance(meta_for_image.get("folder"), str) else eagle_folder
            website_value = meta_for_image.get("website") if isinstance(meta_for_image.get("website"), str) else ""
            name_value = meta_for_image.get("name") if isinstance(meta_for_image.get("name"), str) else ""

            method_for_this = send_method
            if send_target != "Eagle Bridge Plugin":
                method_for_this = "addFromPath (native)"
            else:
                method_for_this = _select_send_method(send_method, file_path, auto_base64_max_mb)

            try:
                size_bytes = os.path.getsize(file_path)
            except Exception:
                size_bytes = None

            if str(send_method).lower().startswith("auto"):
                if size_bytes is not None:
                    print(
                        f"[Eagle Send] Auto send_method resolved to {method_for_this} "
                        f"(size={size_bytes} bytes, threshold={auto_base64_max_mb} MB)"
                    )
                else:
                    print(f"[Eagle Send] Auto send_method resolved to {method_for_this} (size=unknown)")
            else:
                print(f"[Eagle Send] send_method={method_for_this}")

            try:
                if send_target == "Eagle Bridge Plugin":
                    bridge_base = _normalize_api_base(eagle_base_url)
                    headers = {"Content-Type": "application/json"}
                    if eagle_token:
                        headers["Authorization"] = f"Bearer {eagle_token}"
                    if method_for_this.startswith("addFromBase64"):
                        with open(file_path, "rb") as fh:
                            raw = fh.read()
                        b64 = base64.b64encode(raw).decode("ascii")
                        mime = _guess_mime_from_ext(ext)
                        payload = {
                            "base64": f"data:{mime};base64,{b64}",
                            "name": name_value or file_name,
                            "website": website_value,
                            "annotation": annotation,
                            "tags": tags,
                            "folder": folder_value,
                        }
                        resp = requests.post(f"{bridge_base}/api/add_from_base64", headers=headers, json=payload, timeout=150)
                    else:
                        payload = {
                            "url": file_url,
                            "name": name_value or file_name,
                            "website": website_value,
                            "annotation": annotation,
                            "tags": tags,
                            "folder": folder_value,
                        }
                        resp = requests.post(f"{bridge_base}/api/add_from_url", headers=headers, json=payload, timeout=150)
                    resp.raise_for_status()
                    data = resp.json()
                    results.append({"ok": True, "file_path": file_path, "file_url": file_url, "eagle_item_id": data.get("itemId")})
                else:
                    native_base = _normalize_api_base(eagle_base_url)
                    folder_id = _eagle_native_find_or_create_folder(native_base, eagle_token or None, folder_value)

                    payload = {
                        "path": file_path,
                        "name": name_value or file_name,
                        "website": website_value,
                        "annotation": annotation,
                        "tags": tags,
                    }
                    if folder_id:
                        payload["folderId"] = folder_id
                    if eagle_token:
                        payload["token"] = eagle_token
                    native_headers = {"Content-Type": "application/json"}
                    if eagle_token:
                        native_headers["Authorization"] = f"Bearer {eagle_token}"
                    resp = requests.post(f"{native_base}/api/item/addFromPath", headers=native_headers, json=payload, timeout=150)
                    resp.raise_for_status()
                    data = resp.json()
                    results.append({"ok": True, "file_path": file_path, "file_url": file_url, "eagle_item_id": (data.get("data") or {}).get("id", None) or data.get("data")})
            except Exception as e:
                results.append({"ok": False, "file_path": file_path, "file_url": file_url, "error": str(e)})

        return (json.dumps(results, ensure_ascii=False), images)


class EagleQuickSendToEagle:
    """Send images to Eagle through the bridge with practical defaults."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
            },
            "optional": {
                "eagle_folder": ("STRING", {"default": "", "multiline": False}),
                "name": ("STRING", {"default": "", "multiline": False, "placeholder": "Optional display name in Eagle"}),
                "annotation": ("STRING", {"default": "", "multiline": True}),
                "tags_csv": ("STRING", {"default": "source:comfyui", "multiline": False, "placeholder": "tag1,tag2,tag3"}),
                "eagle_meta_json": ("STRING", {"default": "", "multiline": True, "forceInput": True}),
                "send_method": (["addFromPath (local)", "addFromURL (pull)", "addFromBase64 (push)"],),
                "comfyui_public_url": ("STRING", {"default": "http://127.0.0.1:8188", "multiline": False}),
                "eagle_native_url": ("STRING", {"default": "http://127.0.0.1:41595", "multiline": False}),
                "eagle_token": ("STRING", {"default": "", "multiline": False}),
                "file_format": (["png", "jpeg", "webp"],),
            },
            "hidden": {"prompt": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO"},
        }

    RETURN_TYPES = ("STRING", "IMAGE")
    RETURN_NAMES = ("send_result_json", "images")
    FUNCTION = "send"
    OUTPUT_NODE = True
    CATEGORY = "Eagle"

    def send(
        self,
        images,
        eagle_folder="",
        name="",
        annotation="",
        tags_csv="source:comfyui",
        eagle_meta_json="",
        send_method="addFromPath (local)",
        comfyui_public_url="http://127.0.0.1:8188",
        eagle_native_url="http://127.0.0.1:41595",
        eagle_token="",
        file_format="png",
        prompt=None,
        extra_pnginfo=None,
    ):
        meta = {}
        if isinstance(eagle_meta_json, str) and eagle_meta_json.strip():
            try:
                parsed = json.loads(eagle_meta_json)
                if isinstance(parsed, dict):
                    meta.update(parsed)
            except Exception:
                pass
        if isinstance(eagle_folder, str) and eagle_folder.strip():
            meta["folder"] = eagle_folder.strip()
        if isinstance(name, str) and name.strip():
            meta["name"] = name.strip()
        if isinstance(annotation, str) and annotation.strip():
            meta["annotation"] = annotation.strip()
        tags = []
        if isinstance(meta.get("tags"), list):
            tags.extend([tag for tag in meta.get("tags") if isinstance(tag, str) and tag.strip()])
        tags.extend(_parse_tags_csv(tags_csv))
        if tags:
            meta["tags"] = tags

        use_native_path = str(send_method or "").startswith("addFromPath")
        target = "Eagle Native API" if use_native_path else "Eagle Bridge Plugin"
        method = "addFromURL (pull)" if use_native_path else send_method
        base_url = eagle_native_url if use_native_path else EAGLE_API_BASE
        token = eagle_token if use_native_path else EAGLE_BRIDGE_TOKEN

        return EagleSendToEagle().send(
            images=images,
            send_target=target,
            send_method=method,
            eagle_base_url=base_url,
            eagle_token=token,
            eagle_folder="",
            comfyui_public_url=comfyui_public_url,
            file_format=file_format,
            lossless_webp=True,
            quality=95,
            auto_base64_max_mb=1,
            save_prompt_tags=False,
            save_negative_prompt_tags=False,
            extra_tags_csv="",
            eagle_meta_json=json.dumps(meta, ensure_ascii=False) if meta else "",
            memo="",
            positive="",
            negative="",
            prompt=prompt,
            extra_pnginfo=extra_pnginfo,
        )


class EagleUpdateItem:
    """Update Eagle item metadata (star/tags/annotation/folder/trash) via Eagle Bridge."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "metadata_json": ("STRING", {"default": "", "multiline": True}),
            },
            "optional": {
                "item_id": ("STRING", {"default": "", "multiline": False}),
                "toggle_star": ("BOOLEAN", {"default": False}),
                "star": ("INT", {"default": -1, "min": -1, "max": 5, "step": 1}),
                "apply_tags_set": ("BOOLEAN", {"default": False}),
                "tags_set_csv": ("STRING", {"default": "", "multiline": False, "placeholder": "tag1,tag2"}),
                "tags_add_csv": ("STRING", {"default": "", "multiline": False, "placeholder": "tag1,tag2"}),
                "tags_remove_csv": ("STRING", {"default": "", "multiline": False, "placeholder": "tag1,tag2"}),
                "apply_annotation_set": ("BOOLEAN", {"default": False}),
                "annotation_set": ("STRING", {"default": "", "multiline": True}),
                "annotation_append": ("STRING", {"default": "", "multiline": True}),
                "apply_folder": ("BOOLEAN", {"default": False}),
                "folder": ("STRING", {"default": "", "multiline": False, "placeholder": "Folder ID or path A/B/C (empty = clear)"}),
                "trash": ("BOOLEAN", {"default": False}),
                "confirm_trash": ("BOOLEAN", {"default": False}),
                "item_json": ("STRING", {"default": "", "multiline": True}),
            }
        }

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("metadata_json", "result_json")
    FUNCTION = "update_item"
    CATEGORY = "Eagle"

    def update_item(
        self,
        metadata_json,
        item_id="",
        toggle_star=False,
        star=-1,
        apply_tags_set=False,
        tags_set_csv="",
        tags_add_csv="",
        tags_remove_csv="",
        apply_annotation_set=False,
        annotation_set="",
        annotation_append="",
        apply_folder=False,
        folder="",
        trash=False,
        confirm_trash=False,
        item_json="",
    ):
        try:
            item = {}
            item_source = metadata_json if isinstance(metadata_json, str) and metadata_json.strip() else item_json
            if isinstance(item_source, str) and item_source.strip():
                item = json.loads(item_source)
            resolved_id = (item_id or "").strip() or str(item.get("id") or "").strip()
            if not resolved_id:
                raise RuntimeError("Missing item id (provide item_id or metadata_json with id)")

            payload = {"id": resolved_id}

            if trash and not confirm_trash:
                raise RuntimeError("trash is enabled but confirm_trash is false")
            if trash:
                payload["trash"] = True
            if toggle_star:
                payload["toggle_star"] = True
            elif isinstance(star, int) and star >= 0:
                payload["star"] = int(star)

            if apply_tags_set:
                payload["tags_set"] = _parse_tags_csv(tags_set_csv or "")
            else:
                tags_add = _parse_tags_csv(tags_add_csv or "")
                tags_remove = _parse_tags_csv(tags_remove_csv or "")
                if tags_add:
                    payload["tags_add"] = tags_add
                if tags_remove:
                    payload["tags_remove"] = tags_remove

            if apply_annotation_set:
                payload["annotation_set"] = str(annotation_set or "")
            if isinstance(annotation_append, str) and annotation_append.strip():
                payload["annotation_append"] = annotation_append

            if apply_folder:
                payload["folder"] = str(folder or "")

            headers = {"Content-Type": "application/json"}
            if EAGLE_BRIDGE_TOKEN:
                headers["Authorization"] = f"Bearer {EAGLE_BRIDGE_TOKEN}"

            resp = requests.post(f"{EAGLE_API_BASE}/update_item", headers=headers, json=payload, timeout=15)
            resp.raise_for_status()
            data = resp.json()
            updated_item = data.get("item") or {}
            return (json.dumps(updated_item, ensure_ascii=False), json.dumps(data, ensure_ascii=False))
        except Exception as e:
            return ("", json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))


class EagleQuickUpdateItem:
    """Update common Eagle item metadata fields with a smaller input surface."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "metadata_json": ("STRING", {"default": "", "multiline": True}),
            },
            "optional": {
                "item_id": ("STRING", {"default": "", "multiline": False}),
                "star": ("INT", {"default": -1, "min": -1, "max": 5, "step": 1}),
                "tags_add_csv": ("STRING", {"default": "", "multiline": False, "placeholder": "tag1,tag2"}),
                "tags_remove_csv": ("STRING", {"default": "", "multiline": False, "placeholder": "tag1,tag2"}),
                "annotation_append": ("STRING", {"default": "", "multiline": True}),
                "folder": ("STRING", {"default": "", "multiline": False, "placeholder": "Folder ID or path A/B/C (empty = no change)"}),
                "trash": ("BOOLEAN", {"default": False}),
                "confirm_trash": ("BOOLEAN", {"default": False}),
            }
        }

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("metadata_json", "result_json")
    FUNCTION = "update_item"
    CATEGORY = "Eagle"

    def update_item(
        self,
        metadata_json,
        item_id="",
        star=-1,
        tags_add_csv="",
        tags_remove_csv="",
        annotation_append="",
        folder="",
        trash=False,
        confirm_trash=False,
    ):
        return EagleUpdateItem().update_item(
            metadata_json=metadata_json,
            item_id=item_id,
            toggle_star=False,
            star=star,
            apply_tags_set=False,
            tags_set_csv="",
            tags_add_csv=tags_add_csv,
            tags_remove_csv=tags_remove_csv,
            apply_annotation_set=False,
            annotation_set="",
            annotation_append=annotation_append,
            apply_folder=bool(isinstance(folder, str) and folder.strip()),
            folder=folder,
            trash=trash,
            confirm_trash=confirm_trash,
            item_json="",
        )


class EagleExtractEmbeddedWorkflow:
    """Extract embedded ComfyUI workflow/prompt metadata from an Eagle item image (typically PNG)."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "optional": {
                "item_id": ("STRING", {"default": "", "multiline": False}),
                "metadata_json": ("STRING", {"default": "", "multiline": True, "forceInput": True}),
                "item_json": ("STRING", {"default": "", "multiline": True}),
            }
        }

    RETURN_TYPES = ("STRING", "STRING", "STRING")
    RETURN_NAMES = ("workflow_json", "prompt_json", "keys_json")
    FUNCTION = "extract"
    CATEGORY = "Eagle"

    def extract(self, item_id="", metadata_json="", item_json=""):
        try:
            item = {}
            item_source = metadata_json if isinstance(metadata_json, str) and metadata_json.strip() else item_json
            if isinstance(item_source, str) and item_source.strip():
                item = json.loads(item_source)
                if not isinstance(item, dict):
                    item = {}

            resolved_id = (item_id or "").strip() or str(item.get("id") or "").strip()
            if not resolved_id:
                raise RuntimeError("Missing item id (provide item_id or metadata_json with id)")

            if not item.get("filePath"):
                headers = {}
                if EAGLE_BRIDGE_TOKEN:
                    headers["Authorization"] = f"Bearer {EAGLE_BRIDGE_TOKEN}"
                resp = requests.get(f"{EAGLE_API_BASE}/get_image", params={"id": resolved_id}, headers=headers, timeout=10)
                resp.raise_for_status()
                item = resp.json() or {}
            item["id"] = resolved_id

            image_bytes, _source = _load_item_bytes(item)
            meta = _extract_comfyui_embedded_metadata(image_bytes)
            workflow = meta.get("workflow") if meta.get("has_workflow") else None
            prompt_obj = meta.get("prompt")
            keys = sorted(list((meta.get("parsed") or {}).keys()))

            workflow_json = json.dumps(workflow, ensure_ascii=False) if workflow is not None else ""
            prompt_json = json.dumps(prompt_obj, ensure_ascii=False) if prompt_obj is not None else ""
            keys_json = json.dumps(keys, ensure_ascii=False)
            return (workflow_json, prompt_json, keys_json)
        except Exception as e:
            return ("", "", json.dumps({"error": str(e)}, ensure_ascii=False))

# Node registration
NODE_CLASS_MAPPINGS = {
    "EagleImageBrowser": EagleImageBrowser,
    "EagleImageByID": EagleImageByID,
    "EagleRandomImage": EagleRandomImage,
    "EagleBuildSendInfo": EagleBuildSendInfo,
    "EagleBuildSendInfoSimple": EagleBuildSendInfoSimple,
    "EagleSendToEagle": EagleSendToEagle,
    "EagleQuickSendToEagle": EagleQuickSendToEagle,
    "EagleUpdateItem": EagleUpdateItem,
    "EagleQuickUpdateItem": EagleQuickUpdateItem,
    "EagleExtractEmbeddedWorkflow": EagleExtractEmbeddedWorkflow,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "EagleImageBrowser": "Eagle Image Browser",
    "EagleImageByID": "Eagle Image by ID",
    "EagleRandomImage": "Eagle Random Image",
    "EagleBuildSendInfo": "Eagle Build Send Info",
    "EagleBuildSendInfoSimple": "Eagle Simple Send Info",
    "EagleSendToEagle": "Eagle Send to Eagle",
    "EagleQuickSendToEagle": "Eagle Quick Send to Eagle",
    "EagleUpdateItem": "Eagle Update Item",
    "EagleQuickUpdateItem": "Eagle Quick Update Item",
    "EagleExtractEmbeddedWorkflow": "Eagle Extract Embedded Workflow",
}
